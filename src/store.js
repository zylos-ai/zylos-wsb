import fs from 'node:fs';
import path from 'node:path';

// The live message log and its rotation archives. Rotation (src/server.js)
// creates messages.ndjson.1 .. .N-1 and keepFiles is any integer >= 2, so the
// suffix reaches double digits — which is why this enumerates the directory
// instead of globbing a [0-9] pattern that silently stops at .9.
export const LIVE = 'messages.ndjson';
const ARCHIVE = /^messages\.ndjson\.(\d+)$/;

export function dataFiles(dataDir) {
  return fs.readdirSync(dataDir)
    .filter(name => name === LIVE || ARCHIVE.test(name))
    .sort((a, b) => (Number(a.match(ARCHIVE)?.[1] ?? 0)) - (Number(b.match(ARCHIVE)?.[1] ?? 0)))
    .map(name => path.join(dataDir, name));
}

// DATA.md promises 0600 on every stored message file, reset at every start.
// Rotation renames rather than copies, so archives normally inherit the live
// file's mode — but one restored from a backup, copied by hand, or left by an
// older build does not, and nothing else would ever repair it.
export function secureDataFiles(dataDir) {
  const repaired = [];
  for (const file of dataFiles(dataDir)) {
    try {
      if ((fs.statSync(file).mode & 0o777) === 0o600) continue;
      fs.chmodSync(file, 0o600);
      repaired.push(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return repaired;
}
