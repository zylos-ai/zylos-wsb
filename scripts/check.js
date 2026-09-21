#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnvironment, getConfig } from '../src/config.js';
import { printWebhookInfo } from '../src/webhook-url.js';
import { printConfigurationGuide } from '../src/setup-guide.js';

try {
  loadEnvironment();
  const config = getConfig();
  const { ready } = printConfigurationGuide(config);
  if (!ready) throw new Error('配置检查未通过；请按上面的提示补齐或修正 .env。');
  if (config.mode === 'c4') {
    const skill = path.join(config.zylosDir, '.claude', 'skills', 'wsb');
    let actual;
    try { actual = fs.realpathSync(skill); } catch { /* Report setup guidance below. */ }
    if (actual !== fs.realpathSync(ROOT)) throw new Error('Zylos wsb channel does not point here. Run npm run setup.');
    if (!fs.existsSync(path.join(actual, 'scripts', 'send.js'))) throw new Error('Channel send script is missing.');
  }
  console.log(`[wsb] Local configuration OK. Mode: ${config.mode}; port: ${config.port}.`);
  printWebhookInfo(config);
  console.log('[wsb] This checks local files only. Verify the Meta token, public callback and actual replies with WhatsApp.');
} catch (error) {
  console.error(`[wsb] ${error.message}`);
  process.exitCode = 1;
}
