/**
 * Deploy this plugin repo to the harness component directory, excluding dev-only
 * files, then verify every copied file by SHA-256 against its source.
 *
 * Both paths are resolved rather than written out: the source is the directory
 * holding this script, and the destination comes from `DSH_COMPONENTS_DIR` (a
 * deployment root) or argv[2]. Nothing machine-specific belongs in the repo — it
 * is published, and an absolute path there would disclose the local layout.
 *
 * Usage:
 *   node deploy.mjs <destination-directory>
 *   DSH_COMPONENTS_DIR=<root> node deploy.mjs
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the destination directory from the command line or the environment.
 *
 * `DSH_COMPONENTS_DIR` names the parent that holds every deployed component, so
 * this plugin lands in `<root>/<plugin-name>`; a direct argument is taken as the
 * plugin directory itself.
 * @returns the absolute destination directory.
 * @throws {Error} when neither source of the path is given.
 */
function destination() {
  const direct = process.argv[2];
  if (direct !== undefined && direct !== '') return resolve(direct);
  const root = process.env.DSH_COMPONENTS_DIR;
  if (root !== undefined && root !== '') return join(resolve(root), basename(SOURCE));
  throw new Error('set DSH_COMPONENTS_DIR or pass the destination directory as the first argument');
}

const TARGET = destination();

/**
 * Every regular file under a directory, as paths relative to that directory and
 * slash-separated, so nested files keep their parent directories.
 */
async function walk(root, skip = new Set()) {
  const out = [];
  async function visit(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await visit(root, '');
  return out;
}

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

/** Development-only files that must not ship into the running harness. */
const DEV_ONLY = new Set([
  '.git', 'node_modules', '.gitignore',
  'deploy.mjs', 'prune.mjs', 'check.mjs', 'check-load.mjs', 'check-behavior.mjs',
  'verify-preset-patch.mjs',
]);

const files = await walk(SOURCE, DEV_ONLY);
await mkdir(TARGET, { recursive: true });

const problems = [];
for (const file of files) {
  const from = join(SOURCE, file);
  const to = join(TARGET, file);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
  const [a, b] = [await digest(from), await digest(to)];
  if (a !== b) problems.push(`hash mismatch: ${file}`);
}

// Files present in the deployed copy that the source no longer has.
const deployed = existsSync(TARGET) ? await walk(TARGET, new Set(['node_modules'])) : [];const stale = deployed.filter(file => !files.includes(file));

console.log(`deployed ${files.length} file(s) to ${TARGET}`);
for (const file of files) console.log(`  ${file}`);
if (stale.length > 0) console.log(`stale in target (not in source, left alone): ${stale.join(', ')}`);
if (problems.length > 0) {
  console.log(`\nFAILED:\n${problems.map(p => `  - ${p}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('\nall copied files verified by SHA-256');
}
const missing = ['index.js', 'context.js', 'rubric.js', 'package.json', 'cordis.patch.yml']
  .filter(f => !files.includes(f));
if (missing.length > 0) {
  console.log(`missing required file(s): ${missing.join(', ')}`);
  process.exitCode = 1;
}
