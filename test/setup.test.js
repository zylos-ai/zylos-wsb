import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareInstallation } from '../scripts/setup.js';
import { getConfig, ROOT } from '../src/config.js';
import { getWebhookInfo } from '../src/webhook-url.js';
import { printConfigurationGuide } from '../src/setup-guide.js';

function fixture(t, bridge = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'channel with spaces');
  const zylosDir = path.join(dir, 'zylos');
  const skills = path.join(zylosDir, '.claude', 'skills');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, '.env.example'), 'WSB_MODE=c4\nWSB_VERIFY_TOKEN=\nWSB_ACCESS_TOKEN=\n');
  if (bridge) {
    fs.mkdirSync(path.join(skills, 'comm-bridge', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'comm-bridge', 'scripts', 'c4-receive.js'), '');
  }
  return { root, zylosDir, skill: path.join(skills, 'wsb') };
}

test('portable setup creates a private config and skill link; repeated setup preserves credentials', t => {
  const f = fixture(t);
  assert.deepEqual(prepareInstallation(f.root, f.zylosDir), { createdConfig: true, linked: true });
  const envFile = path.join(f.root, '.env');
  const config = fs.readFileSync(envFile, 'utf8');
  assert.match(config, /^WSB_VERIFY_TOKEN=[a-f0-9]{48}$/m);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.equal(fs.realpathSync(f.skill), fs.realpathSync(f.root));
  fs.appendFileSync(envFile, 'KEEP_THIS=value\n');
  assert.deepEqual(prepareInstallation(f.root, f.zylosDir), { createdConfig: false, linked: false });
  assert.equal(fs.readFileSync(envFile, 'utf8'), config + 'KEEP_THIS=value\n');
});

test('setup refuses an existing different channel without writing config or replacing it', t => {
  const f = fixture(t);
  fs.mkdirSync(f.skill);
  fs.writeFileSync(path.join(f.skill, 'keep.txt'), 'existing channel');
  assert.throws(() => prepareInstallation(f.root, f.zylosDir), /different wsb channel/);
  assert.equal(fs.readFileSync(path.join(f.skill, 'keep.txt'), 'utf8'), 'existing channel');
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
});

test('setup requires the existing Zylos bridge and supports a custom Zylos root', t => {
  const f = fixture(t, false);
  assert.throws(() => prepareInstallation(f.root, f.zylosDir), /comm-bridge not found/);
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false);
  assert.equal(getConfig({ ZYLOS_DIR: f.zylosDir }).c4Receive, path.join(f.zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-receive.js'));
});

test('native install hook preserves global credentials and starts with c4 defaults in a new process', t => {
  const f = fixture(t);
  for (const dir of ['src', 'scripts']) fs.cpSync(path.join(ROOT, dir), path.join(f.root, dir), { recursive: true });
  for (const file of ['package.json', '.env.example']) fs.copyFileSync(path.join(ROOT, file), path.join(f.root, file));
  const globalConfig = 'WSB_ACCESS_TOKEN=fake-global-token\nWSB_APP_SECRET=fake-global-secret\nWSB_PHONE_NUMBER_ID=123\nWSB_VERIFY_TOKEN=fake-global-verify\n';
  fs.writeFileSync(path.join(f.zylosDir, '.env'), globalConfig, { mode: 0o600 });
  // Native Zylos installs a real directory at skills/wsb, not a symlink.
  fs.renameSync(f.root, f.skill);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WSB_') && key !== 'ZYLOS_DIR'));
  const output = execFileSync(process.execPath, [path.join(f.skill, 'scripts', 'setup.js')], { env: { ...env, ZYLOS_DIR: f.zylosDir }, encoding: 'utf8' });
  assert.match(output, /No public domain/);
  for (const secret of ['fake-global-token', 'fake-global-secret']) assert.equal(output.includes(secret), false);
  // The inherited verify token must reach the user; they cannot read the file themselves.
  assert.ok(output.includes('fake-global-verify'));
  const localConfig = fs.readFileSync(path.join(f.skill, '.env'), 'utf8');
  assert.doesNotMatch(localConfig, /^WSB_(?:ACCESS_TOKEN|APP_SECRET|PHONE_NUMBER_ID|VERIFY_TOKEN)=/m);
  // Startup finds the selected custom instance even without ZYLOS_DIR in the process env.
  const code = `import { loadEnvironment, getConfig, validateReceiveConfig } from './src/config.js';
    loadEnvironment(); const c = getConfig(); validateReceiveConfig(c);
    if (c.mode !== 'c4' || c.accessToken !== 'fake-global-token' || c.appSecret !== 'fake-global-secret' || c.verifyToken !== 'fake-global-verify') process.exit(1);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: f.skill, env });
  assert.equal(fs.readFileSync(path.join(f.zylosDir, '.env'), 'utf8'), globalConfig);
  assert.equal(fs.statSync(path.join(f.skill, '.env')).mode & 0o777, 0o600);
});

test('webhook URL follows the Zylos HTTPS domain and reports a missing or mismatched managed route', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.zylosDir, '.zylos'));
  fs.mkdirSync(path.join(f.zylosDir, 'http'));
  fs.writeFileSync(path.join(f.zylosDir, '.zylos', 'config.json'), JSON.stringify({ domain: 'demo.example.com', protocol: 'https' }));
  const config = getConfig({ ZYLOS_DIR: f.zylosDir });
  assert.deepEqual(getWebhookInfo(config), { url: 'https://demo.example.com/whatsapp/webhook', managedRoute: false });
  fs.writeFileSync(path.join(f.zylosDir, 'http', 'Caddyfile'), `demo.example.com {
    # BEGIN zylos-component:wsb
    handle /whatsapp/webhook {
      uri strip_prefix /whatsapp
      reverse_proxy 127.0.0.1:47832 {
        header_up X-Forwarded-Prefix /whatsapp
      }
    }
    # END zylos-component:wsb
  }`);
  assert.equal(getWebhookInfo(config).managedRoute, true);
  assert.equal(getWebhookInfo({ ...config, port: 3000 }).managedRoute, false);
});

test('missing, HTTP or local domains cannot be presented as usable Meta callbacks', t => {
  const f = fixture(t);
  const config = getConfig({ ZYLOS_DIR: f.zylosDir });
  assert.match(getWebhookInfo(config).reason, /ngrok/);
  fs.mkdirSync(path.join(f.zylosDir, '.zylos'));
  const settingsFile = path.join(f.zylosDir, '.zylos', 'config.json');
  for (const settings of [{ domain: 'demo.example.com', protocol: 'http' }, { domain: 'localhost' }, { domain: '127.0.0.1' }]) {
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    assert.equal(getWebhookInfo(config).url, null);
  }
  for (const domain of ['https://demo.example.com', 'demo.example.com/path', 'name:password@demo.example.com']) {
    fs.writeFileSync(settingsFile, JSON.stringify({ domain }));
    assert.throws(() => getWebhookInfo(config), /Invalid Zylos domain/);
  }
  fs.writeFileSync(settingsFile, '{invalid JSON');
  assert.throws(() => getWebhookInfo(config), /Cannot read Zylos/);
});

test('fresh install shows actionable missing settings; after filling them it passes without printing secrets', t => {
  const f = fixture(t);
  for (const dir of ['src', 'scripts']) fs.cpSync(path.join(ROOT, dir), path.join(f.root, dir), { recursive: true });
  for (const file of ['package.json', '.env.example']) fs.copyFileSync(path.join(ROOT, file), path.join(f.root, file));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WSB_') && key !== 'ZYLOS_DIR'));
  env.ZYLOS_DIR = f.zylosDir;
  const setup = path.join(f.root, 'scripts/setup.js');
  const check = path.join(f.root, 'scripts/check.js');
  const output = execFileSync(process.execPath, [setup], { env, encoding: 'utf8' });
  assert.match(output, /Channel 文件已就位，配置尚未完成/);
  for (const name of ['WSB_ACCESS_TOKEN', 'WSB_PHONE_NUMBER_ID', 'WSB_APP_SECRET']) {
    assert.ok(output.includes(`${name}：待填写（必填）`));
  }
  assert.match(output, /WSB_VERIFY_TOKEN：已配置/);
  assert.ok(output.includes(path.join(f.root, '.env')));
  assert.match(output, /npm run check/);
  assert.match(output, /API 测试页/);
  assert.match(output, /App settings/);
  // The user is told, by name, which values only they can fetch from Meta.
  assert.match(output, /developers\.facebook\.com/);
  for (const name of ['WSB_ACCESS_TOKEN', 'WSB_PHONE_NUMBER_ID', 'WSB_APP_SECRET']) {
    assert.ok(output.includes(`  - ${name}：`));
  }
  assert.match(output, /不需要 App ID/);
  const pending = spawnSync(process.execPath, [check], { env, encoding: 'utf8' });
  assert.equal(pending.status, 1);
  assert.match(pending.stdout, /待填写（必填）/);
  const file = path.join(f.root, '.env');
  const original = fs.readFileSync(file, 'utf8');
  const verifyToken = original.match(/^WSB_VERIFY_TOKEN=(.*)$/m)[1];
  fs.appendFileSync(file, '\nWSB_ACCESS_TOKEN=private-demo-access\nWSB_PHONE_NUMBER_ID=123456789\nWSB_APP_SECRET=private-demo-secret\n');
  const configured = fs.readFileSync(file, 'utf8');
  const ready = execFileSync(process.execPath, [setup], { env, encoding: 'utf8' });
  const checked = execFileSync(process.execPath, [check], { env, encoding: 'utf8' });
  assert.match(ready, /本地配置检查通过/);
  assert.doesNotMatch(ready, /待填写（必填）/);
  assert.match(checked, /Local configuration OK/);
  assert.equal(fs.readFileSync(file, 'utf8'), configured);
  for (const value of ['private-demo-access', 'private-demo-secret', '123456789']) {
    assert.ok(!`${output}${ready}${checked}`.includes(value));
  }
  // The generated verify token is handed over, before and after the credentials are filled in.
  for (const printed of [output, ready]) assert.ok(printed.includes(verifyToken));
  assert.match(ready, /messages/);
});

test('configuration guide honors receive-only mode and does not call an invalid phone ID ready', t => {
  const f = fixture(t);
  const lines = [];
  const config = getConfig({ ZYLOS_DIR: f.zylosDir, WSB_MODE: 'log', WSB_VERIFY_TOKEN: 'demo-verify', WSB_APP_SECRET: 'demo-secret', WSB_PHONE_NUMBER_ID: '123' });
  assert.deepEqual(printConfigurationGuide(config, { root: f.root, write: line => lines.push(line) }), { ready: true, missing: [] });
  assert.match(lines.join('\n'), /当前 log 模式可选/);
  const invalid = printConfigurationGuide({ ...config, phoneNumberId: 'not-a-number' }, { root: f.root, write: () => {} });
  assert.equal(invalid.ready, false);
  assert.deepEqual(invalid.missing, []);
});
