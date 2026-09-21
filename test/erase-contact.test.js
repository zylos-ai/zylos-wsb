import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eraseContact, dataFiles, normalize, snapshot, replaceIfUnchanged, ConcurrentWriteError } from '../scripts/erase-contact.js';

const TARGET = '8613800138000';
const OTHER = '15551234567';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-erase-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, name, records) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map(r => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
  return file;
}

const line = (from, text) => ({ id: `wamid.${from}.${text}`, from, type: 'text', text });

test('erasing a contact clears every archive, not just the single-digit ones', async t => {
  const dir = temp(t);
  write(dir, 'messages.ndjson', [line(OTHER, 'a'), line(TARGET, 'b')]);
  write(dir, 'messages.ndjson.1', [line(TARGET, 'c')]);
  // keepFiles accepts any integer >= 2, so archives reach double digits - the
  // exact case the old shell snippet's [0-9] pattern skipped.
  write(dir, 'messages.ndjson.10', [line(OTHER, 'd'), line(TARGET, 'e')]);
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'ignore me\n');

  const result = eraseContact(dir, TARGET);
  assert.equal(result.removed, 3);

  const remaining = dataFiles(dir).flatMap(f =>
    fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).from));
  assert.deepEqual(remaining, [OTHER, OTHER]);
  // Emptied rather than deleted: a missing archive would read as "never stored".
  assert.equal(fs.readFileSync(path.join(dir, 'messages.ndjson.1'), 'utf8'), '');
  for (const f of dataFiles(dir)) assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${f} must stay private`);
  assert.equal(fs.existsSync(path.join(dir, 'messages.ndjson.erase-tmp')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), 'ignore me\n');
});

test('only the sender is erased: the same number quoted by someone else survives', async t => {
  const dir = temp(t);
  write(dir, 'messages.ndjson', [line(OTHER, `call me on ${TARGET}`), line(TARGET, 'mine')]);
  assert.equal(eraseContact(dir, TARGET).removed, 1);
  const kept = fs.readFileSync(path.join(dir, 'messages.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(kept.map(r => r.from), [OTHER]);
  assert.match(kept[0].text, new RegExp(TARGET));
});

test('an unparsable line is dropped only when it mentions the number, and is reported', async t => {
  const dir = temp(t);
  const file = write(dir, 'messages.ndjson', [line(OTHER, 'a')]);
  fs.appendFileSync(file, `{"id":"wamid.cut","from":"${TARGET}","te\n{"broken":"other\n`);
  const result = eraseContact(dir, TARGET);
  assert.equal(result.files[0].unreadable, 2);
  assert.equal(result.removed, 1);
  const rest = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(rest.length, 2);
  assert.equal(rest.some(l => l.includes(TARGET)), false);
});

test('a dry run reports the same count and writes nothing', async t => {
  const dir = temp(t);
  const file = write(dir, 'messages.ndjson', [line(TARGET, 'a'), line(OTHER, 'b')]);
  const before = fs.readFileSync(file, 'utf8');
  const result = eraseContact(dir, `+86 138-0013-8000`, { dryRun: true });
  assert.equal(result.number, TARGET); // punctuation and country prefix normalized away
  assert.equal(result.removed, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a missing number is refused instead of matching everything', () => {
  for (const bad of [undefined, '', '   ', '+++']) assert.throws(() => normalize(bad), /Usage/);
});

test('a message arriving mid-cleanup is refused, not silently overwritten', async t => {
  const dir = temp(t);
  const file = write(dir, 'messages.ndjson', [line(TARGET, 'a'), line(OTHER, 'b')]);
  const before = snapshot(file);
  // The channel appends while the rewrite is in flight (src/server.js). The
  // old code renamed over this record and it was gone; now the commit refuses.
  fs.appendFileSync(file, JSON.stringify(line(OTHER, 'arrived during cleanup')) + '\n');

  assert.throws(() => replaceIfUnchanged(file, 'rewritten\n', before), ConcurrentWriteError);
  assert.match(fs.readFileSync(file, 'utf8'), /arrived during cleanup/);
  assert.equal(fs.existsSync(`${file}.erase-tmp`), false);
});

test('an untouched file still commits, and the refusal does not fire spuriously', async t => {
  const dir = temp(t);
  const file = write(dir, 'messages.ndjson', [line(TARGET, 'a'), line(OTHER, 'b')]);
  assert.equal(eraseContact(dir, TARGET).removed, 1);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
