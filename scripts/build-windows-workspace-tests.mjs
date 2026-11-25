import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const define = {
  RELAY_WINDOWS_FIXTURE_SOURCE: JSON.stringify(await readFile('packages/device/test/manual/windows-workspace-fixture.cs', 'utf8')),
  RELAY_WINDOWS_OBSERVER_SOURCE: JSON.stringify(await readFile('packages/device/test/manual/windows-workspace-observe.ps1', 'utf8')),
};
await build({ entryPoints: ['packages/device/test/manual/windows-workspace-smoke.ts'], outfile: '.tmp/windows-workspace-runtime/windows-workspace-smoke.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', define });
