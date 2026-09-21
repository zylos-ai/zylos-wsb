import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildEndpoint, extractMessages, forwardToC4, sendText } from './channel.js';
import { LIVE, secureDataFiles } from './store.js';

function equal(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validSignature(raw, signature, secret) {
  return !!secret && typeof signature === 'string' && /^sha256=[a-f0-9]{64}$/i.test(signature) &&
    equal(signature.toLowerCase(), `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
}

// Bounded retention for stored customer messages. Rotation runs *after* the
// append, so a message is never dropped by the rotation that its own arrival
// triggered, and every archive holds at least one complete record.
// Archives are messages.ndjson.1 (newest) .. .N-1 (oldest); N counts the live
// file, so keepFiles=3 means the live file plus two archives. maxBytes=0 keeps
// the previous unbounded behaviour.
export function rotateIfFull(file, maxBytes, keepFiles) {
  if (!maxBytes) return false;
  // Refused rather than honoured: with no archive to rename into, rotation could
  // only drop the live file, eating the message that just triggered it. config.js
  // rejects the same value at startup; this guards direct callers.
  if (!(keepFiles >= 2)) throw new RangeError('keepFiles must be >= 2; pass maxBytes 0 to disable rotation');
  let size;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  fs.rmSync(`${file}.${keepFiles - 1}`, { force: true });
  for (let i = keepFiles - 2; i >= 1; i--) {
    try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // rename keeps the inode, so the archive keeps the live file's 0600 mode.
  fs.renameSync(file, `${file}.1`);
  return true;
}

export function createMessageHandler(config, { bridge = forwardToC4, send = sendText } = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.dataDir, 0o700);
  const file = path.join(config.dataDir, LIVE);
  // Archives too, not just the live file: they hold the same customer data and
  // the same 0600 promise, and rotation is not the only way one can appear.
  secureDataFiles(config.dataDir);
  return async (message) => {
    fs.appendFileSync(file, JSON.stringify({ receivedAt: new Date().toISOString(), ...message }) + '\n', { mode: 0o600 });
    rotateIfFull(file, config.dataMaxBytes, config.dataKeepFiles);
    // Non-text messages remain inspectable in the log; this demo only replies to text.
    if (message.type !== 'text' || !message.text) return;
    if (config.mode === 'c4') await bridge(config, message);
    if (config.mode === 'echo') {
      const reply = `收到：${Array.from(message.text).slice(0, 4093).join('')}`;
      await send(config, buildEndpoint(message), reply);
    }
  };
}

export function createWebhookServer(config, { handleMessage = createMessageHandler(config), logger = console } = {}) {
  const completed = new Map();
  const inFlight = new Map();
  const ttl = 24 * 60 * 60 * 1000;
  let activeRequests = 0;

  async function processMessage(message) {
    const now = Date.now();
    for (const [id, time] of completed) if (now - time >= ttl) completed.delete(id);
    if (completed.has(message.id)) return;
    if (inFlight.has(message.id)) return inFlight.get(message.id);
    const work = (async () => {
      await handleMessage(message);
      completed.set(message.id, Date.now());
      if (completed.size > 10000) completed.delete(completed.keys().next().value);
      logger.info(`[wsb] Received ${message.type} message`);
    })();
    inFlight.set(message.id, work);
    try { await work; } finally { inFlight.delete(message.id); }
  }

  const server = http.createServer(async (req, res) => {
    const respond = (code, text) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return respond(400, 'Invalid URL'); }
    if (url.pathname === '/health' && req.method === 'GET') return respond(200, 'ok');
    if (!['/whatsapp/webhook', '/webhook'].includes(url.pathname)) return respond(404, 'Not found');
    if (req.method === 'GET') {
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      return url.searchParams.get('hub.mode') === 'subscribe' && challenge !== null &&
        config.verifyToken && token && equal(token, config.verifyToken)
        ? respond(200, challenge) : respond(403, 'Verification failed');
    }
    if (req.method !== 'POST') return respond(405, 'Method not allowed');
    if (activeRequests >= 8) return respond(503, 'Busy; retry later');
    activeRequests++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) return respond(413, 'Payload too large');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) return respond(401, 'Invalid signature');
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return respond(400, 'Invalid JSON'); }
      if (body?.object !== 'whatsapp_business_account') return respond(400, 'Invalid webhook object');
      const messages = extractMessages(body, config.phoneNumberId);
      for (const message of messages) await processMessage(message);
      // Status-only callbacks and messages for other phone numbers need no reply.
      respond(200, 'EVENT_RECEIVED');
    } catch (error) {
      // Channel adapters sanitize remote errors; never log the request body or headers.
      logger.error(`[wsb] Processing failed: ${error.message}. Returning 503 for retry.`);
      respond(503, 'Processing failed; retry later');
    } finally {
      activeRequests--;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  return server;
}
