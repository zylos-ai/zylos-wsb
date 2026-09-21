#!/usr/bin/env node
// Deletes every stored record of one customer, across the live message log and
// all of its archives. Rotation bounds the data by *volume*; this bounds it by
// *subject*, which is what a GDPR-style erasure request actually asks for.
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnvironment } from '../src/config.js';
import { dataFiles } from '../src/store.js';

// Enumerated from the directory, not globbed — see src/store.js for why.
export { dataFiles };

// Only digits are compared: the log stores bare numbers, but people paste
// +86 138-0013-8000 from a chat window.
export function normalize(number) {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (!digits) throw new Error('Usage: node scripts/erase-contact.js <customer-number> [--dry-run]');
  return digits;
}

export class ConcurrentWriteError extends Error {
  constructor(file) {
    super(`${path.basename(file)} changed while it was being rewritten; refusing to commit. ` +
      'A message that arrived mid-cleanup would be destroyed by the rename. ' +
      'Stop the channel first (pm2 stop zylos-wsb), then re-run — erasure is idempotent, so a repeat run is safe.');
    this.name = 'ConcurrentWriteError';
  }
}

// Identity and length of a stored file at one instant.
export function snapshot(file) {
  const stats = fs.statSync(file);
  return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

// Commit only if the file is still the one that was read. Erasure is a
// read-modify-write and the channel appends to the same path, so a message
// landing between the read and the rename would be thrown away with the old
// inode. This is a check, not a lock: the writer is not asked to cooperate, so
// an append in the microseconds between the final check and the rename is
// still lost. Stopping the channel is the guarantee; this downgrades the
// common case from silent data loss to a refusal the operator can act on.
export function replaceIfUnchanged(file, content, expected) {
  if (snapshot(file) !== expected) throw new ConcurrentWriteError(file);
  const temp = `${file}.erase-tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.chmodSync(temp, 0o600); // An existing temp file keeps its own mode.
  try {
    if (snapshot(file) !== expected) throw new ConcurrentWriteError(file);
    fs.renameSync(temp, file); // rename carries 0600 over; a copy would not.
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// Records are matched by parsing each line and reading `from`, never by
// substring: the number may also appear inside someone else's message text, and
// those records belong to a different data subject.
function filterFile(file, number, dryRun) {
  // Taken before the read, so the commit check below also catches an append
  // that landed while the file was being read.
  const before = snapshot(file);
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n').filter(line => line !== '');
  let unreadable = 0;
  const kept = lines.filter(line => {
    let record;
    try { record = JSON.parse(line); }
    // A truncated line cannot be attributed. Erasure wins over retention, so it
    // is dropped when the number appears anywhere in it, and reported either way.
    catch { unreadable++; return !line.includes(number); }
    return String(record.from ?? '') !== number;
  });
  const removed = lines.length - kept.length;
  // Emptied, not deleted: the live file is reopened by append, and a missing
  // archive would read as "these messages were never stored".
  if (removed && !dryRun) replaceIfUnchanged(file, kept.map(line => line + '\n').join(''), before);
  return { file, scanned: lines.length, removed, kept: kept.length, unreadable };
}

export function eraseContact(dataDir, rawNumber, { dryRun = false } = {}) {
  const number = normalize(rawNumber);
  const files = dataFiles(dataDir).map(file => filterFile(file, number, dryRun));
  return { number, dryRun, files, removed: files.reduce((sum, f) => sum + f.removed, 0) };
}

export function main(args = process.argv.slice(2), config = null) {
  const dryRun = args.includes('--dry-run');
  const number = args.find(arg => !arg.startsWith('-'));
  if (!config) { loadEnvironment(); config = getConfig(); }
  const result = eraseContact(config.dataDir, number, { dryRun });
  for (const f of result.files) {
    console.log(`${path.basename(f.file)}: ${f.removed} removed, ${f.kept} kept${f.unreadable ? `, ${f.unreadable} unreadable line(s)` : ''}`);
  }
  console.log(dryRun
    ? `Dry run: ${result.removed} record(s) of ${result.number} would be deleted. Re-run without --dry-run.`
    : `Deleted ${result.removed} record(s) of ${result.number}.`);
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`[wsb] ${error.message}`); process.exitCode = 1; }
}
