import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const image = process.env.FIELDWORK_RUNTIME_IMAGE ?? 'agency-keyword-tracker-api';
test('F15 application runtime excludes development tooling and loads native dependencies', () => {
 const code = `const assert=require('node:assert/strict');for(const name of ['prisma','typescript','typescript-eslint','eslint','vite','@playwright/test']){assert.equal(require('node:fs').existsSync('node_modules/'+name),false,name+' directory must not ship in runtime');assert.throws(()=>require.resolve(name),{code:'MODULE_NOT_FOUND'},name+' must not ship in runtime');}require('@prisma/client');require('argon2');require('undici');console.log('runtime dependencies verified');`;
 const output=execFileSync('docker',['run','--rm','--network','none',image,'node','-e',code],{encoding:'utf8',timeout:60000});
 assert.match(output,/runtime dependencies verified/);
});
