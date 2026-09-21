#!/usr/bin/env node
// Deletes every stored record of one customer, across the live message log and
// all of its archives. Rotation bounds the data by *volume*; this bounds it by
// *subject*, which is what a GDPR-style erasure request actually asks for.
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnvironment } from '../src/config.js';

const LIVE = 'messages.ndjson';

// Only digits are compared: the log stores bare numbers, but people paste
// +86 138-0013-8000 from a chat window.
export function normalize(number) {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (!digits) throw new Error('Usage: node scripts/erase-contact.js <customer-number> [--dry-run]');
  return digits;
}

// Enumerated from the directory, not globbed: keepFiles is any integer >= 2, so
// archives can reach .10 and beyond, which a shell [0-9] pattern silently misses.
export function dataFiles(dataDir) {
  const archive = /^messages\.ndjson\.(\d+)$/;
  return fs.readdirSync(dataDir)
    .filter(name => name === LIVE || archive.test(name))
    .sort((a, b) => (Number(a.match(archive)?.[1] ?? 0)) - (Number(b.match(archive)?.[1] ?? 0)))
    .map(name => path.join(dataDir, name));
}

// Records are matched by parsing each line and reading `from`, never by
// substring: the number may also appear inside someone else's message text, and
// those records belong to a different data subject.
function filterFile(file, number, dryRun) {
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
  if (removed && !dryRun) {
    const temp = `${file}.erase-tmp`;
    fs.writeFileSync(temp, kept.map(line => line + '\n').join(''), { mode: 0o600 });
    fs.chmodSync(temp, 0o600); // An existing temp file keeps its own mode.
    fs.renameSync(temp, file); // rename carries 0600 over; a copy would not.
  }
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
