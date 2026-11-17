/**
 * Verify the deployed preset patch against the shipped base bundle.
 *
 * The loader applies a patch override as a whole-value assignment, so a
 * `config.presets` row REPLACES the table. That makes it easy to erase the
 * built-in presets or their client-localization keys, which has happened. This
 * check composes the two patch files the way the loader does and asserts the
 * result, so the mistake fails here instead of in the permission picker.
 *
 * This script needs two directories that are specific to one installation, so it
 * reads them from the environment instead of carrying them in the repo: this
 * repository is published, and an absolute path here would disclose the local
 * layout.
 *
 * Usage:
 *   DSH_BASE_PATCH=<.../packages/bundle/base/cordis.patch.yml> node verify-preset-patch.mjs
 *   DSH_COMPONENTS_DIR=<root> node verify-preset-patch.mjs
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = dirname(fileURLToPath(import.meta.url));

/**
 * Read a required path from the environment, naming the variable when absent.
 * @param name - environment variable holding the path.
 * @returns the configured path.
 * @throws {Error} when the variable is unset or empty.
 */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/**
 * Locate the composed base patch file the comparison is made against.
 *
 * `DSH_BASE_PATCH` names the file directly; `DSH_BASE_ROOT` names a DSH checkout
 * the conventional path is derived from.
 * @returns the base bundle patch path.
 */
function basePatchPath() {
  const direct = process.env.DSH_BASE_PATCH;
  if (direct !== undefined && direct !== '') return direct;
  return join(required('DSH_BASE_ROOT'), 'packages', 'bundle', 'base', 'cordis.patch.yml');
}

/**
 * Locate this bundle's deployed patch file.
 *
 * `DSH_COMPONENTS_DIR` names the parent holding every deployed component; the
 * plugin directory is its child with this repository's own name.
 * @returns the deployed patch path.
 */
function bundlePatchPath() {
  const direct = process.env.DSH_BUNDLE_PATCH;
  if (direct !== undefined && direct !== '') return direct;
  return join(required('DSH_COMPONENTS_DIR'), basename(SOURCE), 'cordis.patch.yml');
}

/**
 * Read the `presets` block of one `id: permission` row.
 *
 * Both patch files spell this row in the same flat 4-space form the base bundle
 * uses, so a line-oriented read is exact here; it deliberately does not attempt
 * general YAML, and `throws` rather than guessing outside that form.
 * @param text - patch file contents.
 * @param origin - path used in error messages.
 * @returns preset key to `{ sandbox, approval, name?, description? }`.
 */
function readPresets(text, origin) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s{0,6}-\s+id:\s*permission\s*$/.test(line));
  if (start < 0) throw new Error(`${origin}: no "id: permission" patch row`);
  const presetsAt = lines.findIndex((line, index) => index > start && /^\s+presets:\s*$/.test(line));
  if (presetsAt < 0) throw new Error(`${origin}: the permission row has no presets block`);

  const presetsIndent = lines[presetsAt].length - lines[presetsAt].trimStart().length;
  const out = {};
  let current;
  for (let index = presetsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= presetsIndent) break;
    const entry = /^(\s*)([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (indent === presetsIndent + 2 && entry !== null) {
      current = {};
      out[entry[2]] = current;
      continue;
    }
    const field = /^(\s*)([A-Za-z]+):\s*(.+)$/.exec(line);
    if (field === null || current === undefined) throw new Error(`${origin}: unexpected line "${line}"`);
    current[field[2]] = field[3].trim();
  }
  if (Object.keys(out).length === 0) throw new Error(`${origin}: presets block is empty`);
  return out;
}

const basePresets = readPresets(readFileSync(basePatchPath(), 'utf8'), 'base bundle');
const bundlePresets = readPresets(readFileSync(bundlePatchPath(), 'utf8'), 'this bundle');

// The loader's semantics: the later `config.presets` value replaces the earlier.
const composed = { ...bundlePresets };

const problems = [];
const expect = (name, sandbox, approval) => {
  const spec = composed[name];
  if (spec === undefined) {
    problems.push(`"${name}" is missing from the composed catalog`);
    return;
  }
  if (spec.sandbox !== sandbox) problems.push(`"${name}": sandbox ${String(spec.sandbox)} != ${sandbox}`);
  if (spec.approval !== approval) problems.push(`"${name}": approval ${String(spec.approval)} != ${approval}`);
  if (Object.hasOwn(spec, 'name')) {
    problems.push(`"${name}" carries a name; the client localizes only when name === key, so this would drop its translation`);
  }
};

// Built-in presets must keep exactly the base bundle's knob values.
for (const [name, spec] of Object.entries(basePresets)) {
  expect(name, spec.sandbox, spec.approval);
}
// The plugin's own preset is the only addition.
expect('codex-autoreview', 'workspace-write', 'ask');

const added = Object.keys(composed).filter(name => !Object.hasOwn(basePresets, name));
const removed = Object.keys(basePresets).filter(name => !Object.hasOwn(composed, name));
if (removed.length > 0) problems.push(`built-in presets removed: ${removed.join(', ')}`);

console.log(`base presets:   ${Object.keys(basePresets).join(', ')}`);
console.log(`composed:       ${Object.keys(composed).join(', ')}`);
console.log(`added:          ${added.join(', ') || '(none)'}`);
if (problems.length === 0) {
  console.log('\nPASS: built-in presets intact and localized, codex-autoreview is the only addition');
} else {
  console.log('\nFAIL:');
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exitCode = problems.length === 0 ? 0 : 1;
