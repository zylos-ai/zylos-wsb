#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, loadEnvironment, getConfig } from '../src/config.js';
import { printWebhookInfo } from '../src/webhook-url.js';
import { printConfigurationGuide } from '../src/setup-guide.js';

export function prepareInstallation(root, zylosDir, env = {}) {
  const target = fs.realpathSync(root);
  const skills = path.join(zylosDir, '.claude', 'skills');
  const receiver = path.join(skills, 'comm-bridge', 'scripts', 'c4-receive.js');
  if (!fs.existsSync(receiver)) {
    throw new Error('Zylos comm-bridge not found. Install and start Zylos first, or set ZYLOS_DIR.');
  }
  const skill = path.join(skills, 'wsb');
  let installed = false;
  try {
    fs.lstatSync(skill);
    installed = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (installed) {
    let current;
    try { current = fs.realpathSync(skill); } catch { /* Broken links also conflict. */ }
    if (current !== target) throw new Error('A different wsb channel already exists. Nothing was overwritten.');
  }

  const envFile = path.join(target, '.env');
  let createdConfig = false;
  if (!fs.existsSync(envFile)) {
    const example = fs.readFileSync(path.join(target, '.env.example'), 'utf8');
    // Zylos add saves credentials in its global .env. Empty local placeholders
    // must not shadow those values when the channel starts in a fresh process.
    let content = example.replace(/^WSB_VERIFY_TOKEN=.*$/m,
      env.WSB_VERIFY_TOKEN ? '# WSB_VERIFY_TOKEN is inherited from Zylos.' : `WSB_VERIFY_TOKEN=${randomBytes(24).toString('hex')}`);
    content = content.replace(/^(WSB_[A-Z_]+)=\s*$/gm, '# $1=');
    content += `\n# Keep the installer-selected Zylos instance for service startup and replies.\nZYLOS_DIR=${JSON.stringify(path.resolve(zylosDir))}\n`;
    fs.writeFileSync(envFile, content, { flag: 'wx', mode: 0o600 });
    createdConfig = true;
  }
  if (!installed) fs.symlinkSync(target, skill, 'dir');
  return { createdConfig, linked: !installed };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadEnvironment();
    const result = prepareInstallation(ROOT, getConfig().zylosDir, process.env);
    loadEnvironment();
    console.log(`[wsb] Config: ${result.createdConfig ? 'created private .env; verify token generated or inherited' : 'existing .env preserved'}`);
    console.log(`[wsb] Channel: ${result.linked ? 'linked into Zylos' : 'already linked'}`);
    const config = getConfig();
    const { ready } = printConfigurationGuide(config);
    printWebhookInfo(config);
    if (ready) {
      console.log('[wsb] 下一步：确认 Channel 已启动，将上面的回调地址及 Verify token 填入 Meta 并点「验证并保存」。');
      console.log('[wsb] 保存后必须再订阅 Webhook 的 messages 字段：验证通过 ≠ 会推消息，漏订阅不报错、消息永远不来。');
      console.log('[wsb] 两步都完成后再测试真实收发。标准 zylos add 会继续启动服务；本机源码调试使用 npm start。');
    } else {
      console.log('[wsb] 配置完成前无法正常收发。补齐后若使用 PM2：pm2 restart zylos-wsb；本机源码调试：npm start。');
    }
  } catch (error) {
    console.error(`[wsb] ${error.message}`);
    process.exitCode = 1;
  }
}
