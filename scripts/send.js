#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnvironment } from '../src/config.js';
import { sendText } from '../src/channel.js';

export async function readMessage(args, stdin) {
  if (args.length >= 2) return args.slice(1).join(' '); // Current C4 passes argv.
  if (stdin.isTTY) throw new Error('Usage: node scripts/send.js <endpoint> "message" (or pipe message on stdin)');
  stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of stdin) {
    text += chunk;
    if (text.length > 32768) throw new Error('Message too large');
  }
  return text;
}

export async function main(args = process.argv.slice(2), stdin = process.stdin, send = sendText) {
  if (!args[0]) throw new Error('Usage: node scripts/send.js <endpoint> "message"');
  const text = await readMessage(args, stdin);
  if (text.trim() === '[SKIP]') return;
  loadEnvironment();
  const result = await send(getConfig(), args[0], text);
  console.log(JSON.stringify({ ok: true, ...result }));
}

// C4 invokes this entry point through the skill directory's symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[wsb] ${error.message}`); process.exitCode = 1; });
}
