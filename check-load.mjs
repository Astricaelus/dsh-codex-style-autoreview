/**
 * Load-shape check: the module must import cleanly and expose the function-plugin
 * form (named `apply`, no default export) with no harness-internal imports.
 */
const module = await import('./index.js');
const problems = [];
if (typeof module.apply !== 'function') problems.push('missing named export: apply');
if (module.default !== undefined) problems.push('must not have a default export');
for (const key of Object.keys(module)) {
  if (!['apply'].includes(key)) problems.push(`unexpected extra export: ${key}`);
}
const source = await import('node:fs').then(fs => fs.promises.readFile(new URL('./index.js', import.meta.url), 'utf8'));
if (/from\s+['"]@deepseek-ai\//.test(source)) problems.push('imports a harness-internal package');
if (/\bfunction\*/.test(source) === false) problems.push('expected a generator effect');

if (problems.length > 0) {
  console.log(`load shape FAILED:\n${problems.map(p => `  - ${p}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('load shape ok: apply() exported, no default export, no harness-internal imports');
}
