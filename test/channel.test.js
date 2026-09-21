import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, validateReceiveConfig } from '../src/config.js';
import { createWebhookServer, createMessageHandler, rotateIfFull } from '../src/server.js';
import { buildEndpoint, sendText, forwardToC4 } from '../src/channel.js';
import { readMessage } from '../scripts/send.js';

const base = getConfig({ WSB_PHONE_NUMBER_ID: '123456789', WSB_APP_SECRET: 'test-secret', WSB_VERIFY_TOKEN: 'test-verify', WSB_ACCESS_TOKEN: 'test-access' });
const quiet = { info() {}, error() {} };
const incoming = (id = 'wamid.one', from = '15551234567') => ({ id, from, timestamp: '1789980000', type: 'text', text: { body: '你好 <customer> & "hello"' } });
const payload = (messages = [incoming()], phone = base.phoneNumberId) => ({
  object: 'whatsapp_business_account', entry: [{ id: '987654321', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phone }, contacts: [{ wa_id: '15551234567', profile: { name: 'Customer' } }], messages
  } }] }]
});

async function start(t, handleMessage) {
  const server = createWebhookServer(base, { handleMessage, logger: quiet });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(url, value, { signature, route = '/whatsapp/webhook' } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const digest = createHmac('sha256', base.appSecret).update(body).digest('hex');
  const response = await fetch(url + route, { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? `sha256=${digest}`
  } });
  return { status: response.status, body: await response.text() };
}

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Meta challenge accepts only the configured token on both callback paths', async t => {
  const url = await start(t, async () => {});
  for (const route of ['/whatsapp/webhook', '/webhook']) {
    const response = await fetch(`${url}${route}?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '12345');
  }
  const rejected = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
  assert.equal(rejected.status, 403);
  await rejected.text();
});

test('rejects invalid signatures, malformed JSON and wrong objects before handling', async t => {
  let count = 0;
  const url = await start(t, async () => count++);
  assert.equal((await post(url, payload(), { signature: 'sha256=' + '0'.repeat(64) })).status, 401);
  assert.equal((await post(url, '{broken')).status, 400);
  assert.equal((await post(url, { object: 'page' })).status, 400);
  assert.equal((await post(url, null)).status, 400);
  assert.equal(count, 0);
});

test('rejects oversized callback bodies without processing them', async t => {
  const url = await start(t, async () => assert.fail('must not handle'));
  assert.equal((await post(url, 'x'.repeat(1024 * 1024 + 1))).status, 413);
});

test('routes all customers for the configured number; ignores status-only and other numbers', async t => {
  const received = [];
  const url = await start(t, async msg => received.push(msg));
  assert.equal((await post(url, payload([incoming(), incoming('wamid.two', '15557654321')]))).status, 200);
  assert.equal(received.length, 2);
  assert.equal(received[0].text, incoming().text.body);
  assert.equal(received[1].from, '15557654321');
  assert.equal((await post(url, payload([incoming('wamid.wrong')], '999999'))).status, 200);
  const statuses = payload([]);
  statuses.entry[0].changes[0].value.statuses = [{ id: 'outbound', status: 'delivered' }];
  assert.equal((await post(url, statuses)).status, 200);
  assert.equal(received.length, 2);
});

test('concurrent retries are processed once, and failed processing can be retried', async t => {
  let count = 0;
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const url = await start(t, async message => {
    count++;
    if (message.id === 'wamid.fail' && count === 2) throw new Error('C4 temporarily offline');
    if (message.id === 'wamid.one') { started(); await gate; }
  });
  const first = post(url, payload());
  await ready;
  const second = post(url, payload());
  release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
  assert.equal(count, 1);
  assert.equal((await post(url, payload([incoming('wamid.fail')]))).status, 503);
  assert.equal((await post(url, payload([incoming('wamid.fail')]))).status, 200);
  assert.equal(count, 3);
});

test('partial batch failure does not reprocess previously completed messages', async t => {
  const counts = new Map();
  const url = await start(t, async msg => {
    counts.set(msg.id, (counts.get(msg.id) || 0) + 1);
    if (msg.id === 'wamid.two' && counts.get(msg.id) === 1) throw new Error('retry');
  });
  const batch = payload([incoming(), incoming('wamid.two')]);
  assert.equal((await post(url, batch)).status, 503);
  assert.equal((await post(url, batch)).status, 200);
  assert.equal(counts.get('wamid.one'), 1);
  assert.equal(counts.get('wamid.two'), 2);
});

test('echo mode saves received text and replies to the same customer with message context', async t => {
  const dir = temp(t);
  const sends = [];
  const handler = createMessageHandler({ ...base, mode: 'echo', dataDir: dir }, { send: async (...args) => sends.push(args) });
  const url = await start(t, handler);
  await post(url, payload());
  const records = fs.readFileSync(path.join(dir, 'messages.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[0].text, incoming().text.body);
  assert.equal(sends[0][1], buildEndpoint(incoming()));
  assert.equal(sends[0][2], `收到：${incoming().text.body}`);
  assert.equal(fs.statSync(path.join(dir, 'messages.ndjson')).mode & 0o777, 0o600);
});

test('non-text messages are saved without generating fake text replies', async t => {
  const dir = temp(t);
  const handler = createMessageHandler({ ...base, mode: 'echo', dataDir: dir }, { send: async () => assert.fail('must not send') });
  const url = await start(t, handler);
  const image = { ...incoming(), type: 'image', image: { id: 'media-id' } };
  await post(url, payload([image]));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'messages.ndjson'), 'utf8'));
  assert.equal(saved.raw.image.id, 'media-id');
});

test('the message log rotates at the limit, keeps N files and loses no message in between', async t => {
  const dir = temp(t);
  const file = path.join(dir, 'messages.ndjson');
  const handler = createMessageHandler({ ...base, mode: 'log', dataDir: dir, dataMaxBytes: 500, dataKeepFiles: 3 });
  const ids = name => fs.existsSync(file + name)
    ? fs.readFileSync(file + name, 'utf8').trim().split('\n').map(line => JSON.parse(line).id) : [];
  const sent = [];
  for (let i = 0; i < 30; i++) {
    sent.push(`wamid.${i}`);
    await handler({ ...incoming(`wamid.${i}`), text: 'x'.repeat(100) });
    assert.ok(!fs.existsSync(file) || fs.statSync(file).size < 500, 'the live file never stays over the limit');
  }
  assert.ok(fs.existsSync(`${file}.2`), 'both archives must be kept');
  assert.equal(fs.existsSync(`${file}.3`), false, 'nothing beyond keepFiles may survive');
  // Rotation renames rather than copies, so an archive keeps the live file's mode.
  for (const name of ['.1', '.2']) assert.equal(fs.statSync(file + name).mode & 0o777, 0o600);
  // Oldest archive first, live file last: the surviving records must be an
  // unbroken suffix of what arrived — rotation drops whole files, never lines.
  const kept = ['.2', '.1', ''].flatMap(ids);
  assert.ok(kept.length > 3 && kept.length < sent.length, `expected a trimmed tail, got ${kept.length}`);
  assert.deepEqual(kept, sent.slice(-kept.length));

  // A rotation leaves no live file behind; the next message must recreate it,
  // still private, instead of being dropped.
  let guard = 0;
  while (fs.existsSync(file) && guard++ < 10) await handler({ ...incoming(`wamid.f${guard}`), text: 'x'.repeat(100) });
  assert.equal(fs.existsSync(file), false, 'a rotation should have consumed the live file');
  await handler({ ...incoming('wamid.resumed'), text: 'hi' });
  assert.deepEqual(ids(''), ['wamid.resumed']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('startup re-secures archives, not just the live file', async t => {
  const dir = temp(t);
  // Rotation inherits 0600 through rename, but a file restored from a backup or
  // copied by hand does not - and DATA.md promises 0600 on every start.
  for (const name of ['messages.ndjson', 'messages.ndjson.1', 'messages.ndjson.2', 'messages.ndjson.10']) {
    fs.writeFileSync(path.join(dir, name), '{}\n', { mode: 0o644 });
    fs.chmodSync(path.join(dir, name), 0o644);
  }
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n', { mode: 0o644 });
  fs.chmodSync(path.join(dir, 'unrelated.txt'), 0o644);

  createMessageHandler({ ...base, mode: 'log', dataDir: dir });

  for (const name of ['messages.ndjson', 'messages.ndjson.1', 'messages.ndjson.2', 'messages.ndjson.10']) {
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, `${name} must be private`);
  }
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  // Only our own files: the cleanup must not reach into unrelated content.
  assert.equal(fs.statSync(path.join(dir, 'unrelated.txt')).mode & 0o777, 0o644);
});

test('rotation is opt-out and its limits are validated instead of silently coerced', async t => {
  const dir = temp(t);
  const file = path.join(dir, 'messages.ndjson');
  const handler = createMessageHandler({ ...base, mode: 'log', dataDir: dir, dataMaxBytes: 0, dataKeepFiles: 3 });
  for (let i = 0; i < 20; i++) await handler({ ...incoming(`wamid.${i}`), text: 'x'.repeat(100) });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 20);
  assert.equal(fs.existsSync(`${file}.1`), false, 'maxBytes 0 must disable rotation entirely');
  // keepFiles 1 would leave nowhere to archive to, so rotation would have to drop
  // the live file - including the message that just triggered it. Refused at both
  // the config boundary and the function itself, and the live file stays intact.
  assert.throws(() => rotateIfFull(file, 1, 1), RangeError);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 20);

  assert.equal(getConfig({}).dataMaxBytes, 5 * 1024 * 1024);
  assert.equal(getConfig({}).dataKeepFiles, 3);
  assert.equal(getConfig({ WSB_DATA_MAX_BYTES: '0' }).dataMaxBytes, 0);
  assert.equal(getConfig({ WSB_DATA_KEEP_FILES: '2' }).dataKeepFiles, 2);
  assert.throws(() => getConfig({ WSB_DATA_MAX_BYTES: '-1' }), /WSB_DATA_MAX_BYTES/);
  assert.throws(() => getConfig({ WSB_DATA_MAX_BYTES: '5mb' }), /WSB_DATA_MAX_BYTES/);
  assert.throws(() => getConfig({ WSB_DATA_KEEP_FILES: '0' }), /WSB_DATA_KEEP_FILES/);
  // The value v0.2.0 accepted and this release no longer does, with the escape
  // hatch named in the message so the fix is obvious from the error alone.
  assert.throws(() => getConfig({ WSB_DATA_KEEP_FILES: '1' }), /WSB_DATA_KEEP_FILES.*WSB_DATA_MAX_BYTES=0/s);
});

test('C4 uses a real child process with correct arguments and escaped customer content', async t => {
  const dir = temp(t);
  const script = path.join(dir, 'receiver.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ok:true}));`);
  await forwardToC4({ ...base, c4Receive: script }, { ...incoming(), name: '</name>', text: incoming().text.body });
  const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.deepEqual(args.slice(0, 5), ['--channel', 'wsb', '--endpoint', buildEndpoint(incoming()), '--json']);
  assert.match(args[6], /&lt;customer&gt; &amp; &quot;hello&quot;/);
  assert.ok(!args[6].includes('</name>'));
  fs.writeFileSync(script, 'console.log(JSON.stringify({ok:false}));');
  await assert.rejects(forwardToC4({ ...base, c4Receive: script }, { ...incoming(), text: 'test' }), /rejected/);
});

test('send CLI reads C4 positional content without touching stdin, and also supports stdin', async () => {
  assert.equal(await readMessage(['15551234567', '多行\nmessage'], { isTTY: true }), '多行\nmessage');
  assert.equal(await readMessage(['15551234567'], Readable.from(['hello\n', 'world'])), 'hello\nworld');
  await assert.rejects(readMessage(['15551234567'], { isTTY: true }), /Usage/);
});

test('send CLI executes through the Zylos skill symlink instead of silently exiting', t => {
  const dir = temp(t);
  const skill = path.join(dir, 'wsb');
  fs.symlinkSync(fileURLToPath(new URL('../', import.meta.url)), skill, 'dir');
  const result = spawnSync(process.execPath, [path.join(skill, 'scripts/send.js')], {
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node scripts\/send\.js/);
});

test('Cloud API sends the configured number, bearer token and quoted reply payload', async () => {
  let calls = 0;
  const result = await sendText(base, buildEndpoint(incoming()), '您好', async (url, options) => {
    calls++;
    assert.equal(url, 'https://graph.facebook.com/v25.0/123456789/messages');
    assert.equal(options.headers.Authorization, 'Bearer test-access');
    assert.deepEqual(JSON.parse(options.body), {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '15551234567',
      type: 'text', text: { body: '您好' }, context: { message_id: 'wamid.one' }
    });
    return Response.json({ messages: [{ id: 'wamid.reply' }] });
  });
  assert.equal(result.id, 'wamid.reply');
  assert.equal(calls, 1);
});

test('failed Meta responses have actionable errors without leaking tokens or auto-resending', async () => {
  for (const [code, expected] of [[131047, /window expired/], [190, /token is invalid/], [131031, /account restriction/]]) {
    let calls = 0;
    await assert.rejects(sendText(base, '15551234567', 'hello', async () => {
      calls++;
      return Response.json({ error: { code, message: 'secret test-access' } }, { status: 400 });
    }), error => expected.test(error.message) && !error.message.includes('test-access'));
    assert.equal(calls, 1);
  }
  await assert.rejects(sendText(base, '15551234567', 'hello', async () => { throw new Error('network'); }), /delivery is unknown/);
});

test('missing config, bad destinations and long text fail locally; SKIP makes no API call', async () => {
  assert.throws(() => validateReceiveConfig(getConfig({})), /Missing/);
  assert.throws(() => getConfig({ WSB_MODE: 'wrong' }), /WSB_MODE/);
  const noFetch = () => assert.fail('must not call API');
  await assert.rejects(sendText(base, '../bad', 'hello', noFetch), /Recipient/);
  await assert.rejects(sendText(base, '15551234567', 'a'.repeat(4097), noFetch), /4096/);
  assert.deepEqual(await sendText(base, '', '[SKIP]', noFetch), { skipped: true });
});
