import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function loadEnvironment() {
  // Existing process environment wins; project settings precede Zylos settings.
  const projectFile = path.join(ROOT, '.env');
  if (fs.existsSync(projectFile)) process.loadEnvFile(projectFile);
  const zylosFile = path.join(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'), '.env');
  if (fs.existsSync(zylosFile)) process.loadEnvFile(zylosFile);
}

export function getConfig(env = process.env) {
  const port = Number(env.WSB_PORT || 47832);
  const mode = env.WSB_MODE || 'log';
  const graphVersion = env.WSB_GRAPH_VERSION || 'v25.0';
  const zylosDir = path.resolve(env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WSB_PORT');
  if (!['log', 'echo', 'c4'].includes(mode)) throw new Error('WSB_MODE must be log, echo or c4');
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error('Invalid WSB_GRAPH_VERSION');
  return {
    port, mode, graphVersion, zylosDir,
    verifyToken: env.WSB_VERIFY_TOKEN || '',
    appSecret: env.WSB_APP_SECRET || '',
    phoneNumberId: env.WSB_PHONE_NUMBER_ID || '',
    accessToken: env.WSB_ACCESS_TOKEN || '',
    dataDir: path.resolve(env.WSB_DATA_DIR || path.join(ROOT, 'data')),
    c4Receive: path.resolve(env.WSB_C4_RECEIVE || path.join(zylosDir, '.claude/skills/comm-bridge/scripts/c4-receive.js'))
  };
}

export function validateReceiveConfig(config) {
  const missing = [
    ['WSB_VERIFY_TOKEN', config.verifyToken],
    ['WSB_APP_SECRET', config.appSecret],
    ['WSB_PHONE_NUMBER_ID', config.phoneNumberId],
    ...(config.mode === 'log' ? [] : [['WSB_ACCESS_TOKEN', config.accessToken]])
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Fill the missing values in the channel .env or Zylos .env, then run npm run check. Preserve existing configuration.`);
  if (!/^\d+$/.test(config.phoneNumberId)) throw new Error('WSB_PHONE_NUMBER_ID must be the numeric Meta Phone Number ID');
  if (config.mode === 'c4' && !fs.existsSync(config.c4Receive)) {
    throw new Error('C4 receive script not found. Set WSB_C4_RECEIVE, or first test with WSB_MODE=echo.');
  }
}
