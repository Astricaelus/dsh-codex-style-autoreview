/**
 * Remove deployed files that the source no longer ships (dev-only helpers), then
 * confirm the deployed copy loads and exposes the function-plugin form.
 *
 * The dev-only list is derived from deploy.mjs rather than duplicated here, so a
 * newly added helper cannot be deployed and forgotten by this sweep.
 *
 * Paths are resolved the same way deploy.mjs resolves them — this script's own
 * directory plus `DSH_COMPONENTS_DIR` or argv[2] — because the repository is
 * published and must not carry this machine's layout.
 *
 * Usage:
 *   node prune.mjs <destination-directory>
 *   DSH_COMPONENTS_DIR=<root> node prune.mjs
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the destination directory from the command line or the environment.
 *
 * `DSH_COMPONENTS_DIR` names the parent that holds every deployed component, so
 * this plugin lives in `<root>/<plugin-name>`; a direct argument is taken as the
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

/** Read the DEV_ONLY set straight out of deploy.mjs, the one authority for it. */
async function devOnlyFromDeploy() {
  const text = await readFile(join(SOURCE, 'deploy.mjs'), 'utf8');
  const match = /const DEV_ONLY = new Set\(\[([\s\S]*?)\]\)/.exec(text);
  if (match === null) throw new Error('deploy.mjs no longer declares a DEV_ONLY array');
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
}

const DEV_ONLY = await devOnlyFromDeploy();

let removed = 0;
for (const entry of await readdir(TARGET, { withFileTypes: true })) {
  if (entry.isFile() && DEV_ONLY.has(entry.name)) {
    await rm(join(TARGET, entry.name));
    removed += 1;
    console.log(`removed stale deployed file: ${entry.name}`);
  }
}
if (removed === 0) console.log('no stale dev files in the deployed copy');

const module = await import(pathToFileURL(join(TARGET, 'index.js')).href);
const problems = [];
if (typeof module.apply !== 'function') problems.push('missing apply export');
if (module.default !== undefined) problems.push('unexpected default export');
console.log(problems.length === 0
  ? 'deployed copy loads and exports apply()'
  : `deployed copy FAILED: ${problems.join('; ')}`);
process.exitCode = problems.length === 0 ? 0 : 1;
