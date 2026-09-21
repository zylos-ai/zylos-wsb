import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from '../scripts/check-syntax.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-syntax-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['src', 'scripts', 'test']) fs.mkdirSync(path.join(dir, sub));
  // Mirrors the real package: without "type": "module", node --check treats a
  // .js file with ESM syntax as CommonJS-then-detected and exits 0 on a parse
  // error, which would make this fixture prove the wrong thing.
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  return dir;
}

test('every runtime-loaded file is collected, including the pm2 config', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'b.js'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(dir, 'test', 'c.js'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(dir, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, 'src', 'notes.md'), 'not source\n');

  const found = sourceFiles(dir).map(f => path.relative(dir, f));
  assert.deepEqual(found.sort(), ['ecosystem.config.cjs', 'scripts/b.js', 'src/a.js', 'test/c.js'].sort());
});

test('the real tree is covered and every file in it parses', () => {
  const found = sourceFiles().map(f => path.relative(ROOT, f));
  assert.ok(found.includes('ecosystem.config.cjs'), 'the pm2 config must be checked too');
  assert.ok(found.includes('src/server.js') && found.includes('scripts/erase-contact.js'));
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-syntax.js')]).status, 0);
});

// The bug this script replaces: `node --check good.js bad.js` exits 0, because
// only the first argument is parsed. A batching `find -exec … {} +` therefore
// passed a broken file, and `-exec … \;` did too, since find's exit status
// ignores the utility's. One process per file is the point of the script.
test('a syntax error anywhere in the tree fails the check, not just in the first file', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'src', 'a-good.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'z-broken.js'), 'export const b = ;\n');

  const batched = spawnSync(process.execPath, ['--check', path.join(dir, 'src', 'a-good.js'), path.join(dir, 'src', 'z-broken.js')]);
  assert.equal(batched.status, 0, 'precondition: node --check ignores arguments after the first');

  const perFile = sourceFiles(dir).map(file => spawnSync(process.execPath, ['--check', file]).status);
  assert.deepEqual(perFile, [0, 1], 'checking one file per process must surface the broken one');
});
