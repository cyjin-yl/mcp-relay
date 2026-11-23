// Opt-in metadata check for the four Relay console control families.
// Usage from the repo root: node web/scripts/proto-wc-package-preflight.mjs web
// Requires the consumer packages to be present. Does not load or run package code.
// A pass is only a package-source preflight, not compilation or browser acceptance.
import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const families = ['button', 'dialog', 'tabs', 'switch'];
const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith('--')) {
  throw new Error('Usage: node proto-wc-package-preflight.mjs [web-directory]');
}
const root = await realpath(args[0] ?? '.');
const mods = path.join(root, 'node_modules');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file.startsWith(root + path.sep);
const profile = 'web-component-source-v1';
const receipt = { profile, packages: {}, checks: [] };
const pkg = {};
async function check(label, action) {
  try { receipt.checks.push({ label, ok: true, ...(await action()) }); }
  catch (error) { receipt.checks.push({ label, ok: false, error: error.message }); }
}
async function installed(name) {
  const dir = await realpath(path.join(mods, '@proto.ui', name));
  assert(inside(mods, dir), 'package resolved outside clean consumer node_modules');
  const manifest = await realpath(path.join(dir, 'package.json'));
  assert(inside(dir, manifest), 'manifest escapes installed package');
  const bytes = await readFile(manifest);
  const json = JSON.parse(bytes);
  assert.equal(json.name, '@proto.ui/'+name);
  if (process.env.PROTO_EXPECTED_VERSION) assert.equal(json.version, process.env.PROTO_EXPECTED_VERSION);
  receipt.packages[name] = {
    version: json.version, manifestSha256: sha(bytes),
    protoExports: Object.values(json.exports ?? {}).filter(v => typeof v?.proto === 'string').length,
  };
  return { dir, json };
}
async function source(name, family) {
  const { dir, json } = pkg[name];
  const hint = json.exports?.['./'+family]?.proto;
  assert(typeof hint === 'string' && hint.startsWith('./') && hint.endsWith('.ts') && !hint.endsWith('.d.ts'), 'missing explicit authored TypeScript proto export');
  assert(!/[\\\0%?#*]/.test(hint) && hint.slice(2).split('/').every(part => part && !['.', '..', 'node_modules'].includes(part)), 'invalid package-local source export');
  const file = await realpath(path.resolve(dir, hint));
  assert(inside(dir, file), 'source target escapes installed package');
  assert((await stat(file)).isFile(), 'proto target is not a regular file');
  return { source: hint, sourceSha256: sha(await readFile(file)) };
}
for (const name of ['prototypes-base', 'prototypes-shadcn']) {
  await check('@proto.ui/'+name, async () => { pkg[name] = await installed(name); });
}
for (const family of families) {
  for (const name of ['prototypes-base', 'prototypes-shadcn'])
    if (pkg[name]) await check('@proto.ui/'+name+'/'+family, () => source(name, family));
}
receipt.status = receipt.checks.every(check => check.ok) ? 'preflight-only' : 'failed';
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status === 'failed') process.exitCode = 1;
