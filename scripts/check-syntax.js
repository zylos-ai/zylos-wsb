#!/usr/bin/env node
// Parses every shipped source file, one `node --check` process per file.
//
// Why not `find … -exec node --check {} +`: node --check parses only its first
// argument and treats the rest as script arguments, so a batch exits 0 even
// when the second file onward is broken. Switching to `-exec … \;` does not
// help either — find's exit status ignores the utility's, so both forms
// reported success on a file with a syntax error. Measured, not assumed.
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIRS = ['src', 'scripts', 'test'];
// Not under those directories, but still loaded by a runtime (pm2).
const EXTRA = ['ecosystem.config.cjs'];

export function sourceFiles(root = ROOT) {
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.[cm]?js$/.test(entry.name)) found.push(full);
    }
  };
  for (const dir of DIRS) walk(path.join(root, dir));
  for (const name of EXTRA) if (fs.existsSync(path.join(root, name))) found.push(path.join(root, name));
  return found;
}

export function main() {
  const files = sourceFiles();
  const failed = files.filter(file => spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }).status !== 0);
  console.log(`[wsb] Syntax checked ${files.length} file(s); ${failed.length} failed.`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
