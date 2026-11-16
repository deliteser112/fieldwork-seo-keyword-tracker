import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import semver from 'semver';
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
test('F14 the declared Node range is supported by every locked engine', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.engines?.node) assert.ok(semver.subset(manifest.engines.node, entry.engines.node), `${name}: ${entry.engines.node}`);
  }
  assert.ok(semver.satisfies(process.version, manifest.engines.node));
});
test('F15 lint tooling uses the patched minimatch dependency', () => {
  const fromEstree = createRequire(require.resolve('@typescript-eslint/typescript-estree'));
  assert.ok(semver.gte(fromEstree('minimatch/package.json').version, '11.0.1'));
});
