#!/usr/bin/env node
// Entirely local: Meta responses and the C4 receiver are simulated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createWebhookServer } from '../src/server.js';
import { buildEndpoint, sendText } from '../src/channel.js';
import { readMessage } from './send.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-demo-'));
const c4Receive = path.join(dir, 'c4-receive.cjs');
fs.writeFileSync(c4Receive, `
  const fs = require('node:fs');
  const path = require('node:path');
  fs.writeFileSync(path.join(__dirname, 'c4-args.json'), JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ok: true, id: 1, status: 'queued'}));
`);
const config = getConfig({
  WSB_MODE: 'c4', WSB_PHONE_NUMBER_ID: '1234567890', WSB_APP_SECRET: 'local-demo-secret',
  WSB_VERIFY_TOKEN: 'local-demo-verify', WSB_ACCESS_TOKEN: 'local-demo-token',
  WSB_DATA_DIR: dir, WSB_C4_RECEIVE: c4Receive
});
const server = createWebhookServer(config);
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/whatsapp/webhook`;
  console.log('本地模拟 Demo（不会连接 Meta，也不会发送真实 WhatsApp 消息）');
  const handshake = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=local-demo-verify&hub.challenge=demo-ok`);
  assert.equal(await handshake.text(), 'demo-ok');
  console.log('✓ Webhook 验证通过');

  const message = { id: 'wamid.local-demo', from: '15551234567', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: '你好，我想咨询一下产品' } };
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '987654321', changes: [{
    field: 'messages', value: { metadata: { phone_number_id: config.phoneNumberId },
      contacts: [{ wa_id: message.from, profile: { name: '演示客户' } }], messages: [message] }
  }] }] });
  const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}` };
  const response = await fetch(url, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  await response.text();
  const saved = fs.readFileSync(path.join(dir, 'messages.ndjson'), 'utf8').trim().split('\n');
  assert.equal(saved.length, 1);
  assert.equal(JSON.parse(saved[0]).text, message.text.body);
  console.log(`✓ 收到并保存客户消息：${message.text.body}`);
  const args = JSON.parse(fs.readFileSync(path.join(dir, 'c4-args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--channel') + 1], 'wsb');
  assert.equal(args[args.indexOf('--endpoint') + 1], buildEndpoint(message));
  console.log('✓ 已按 Zylos C4 参数约定转交消息（模拟接收进程）');

  const reply = await readMessage([buildEndpoint(message), '您好，已经收到您的咨询。'], { isTTY: true });
  await sendText(config, buildEndpoint(message), reply, async (target, options) => {
    assert.equal(target, `https://graph.facebook.com/v25.0/${config.phoneNumberId}/messages`);
    const payload = JSON.parse(options.body);
    assert.equal(payload.to, message.from);
    assert.equal(payload.context.message_id, message.id);
    assert.equal(payload.text.body, reply);
    return Response.json({ messages: [{ id: 'wamid.mock-reply' }] });
  });
  console.log(`✓ 回复请求正确：${reply}（模拟 Meta 响应）`);
  const retry = await fetch(url, { method: 'POST', headers, body });
  assert.equal(retry.status, 200);
  await retry.text();
  assert.equal(fs.readFileSync(path.join(dir, 'messages.ndjson'), 'utf8').trim().split('\n').length, 1);
  console.log('✓ 相同回调再次到达时没有重复转交');
  console.log('本地 Demo 通过。真实收发：填写 .env 后执行 npm start，再启动 ngrok。');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
