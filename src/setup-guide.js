import path from 'node:path';
import { ROOT, validateReceiveConfig } from './config.js';

export const META_CONSOLE = 'https://developers.facebook.com/';

export function printConfigurationGuide(config, { root = ROOT, write = console.log } = {}) {
  const fields = [
    { name: 'WSB_ACCESS_TOKEN', value: config.accessToken, required: config.mode !== 'log', hint: 'Meta App → WhatsApp API 测试页 → Access token（访问令牌）' },
    { name: 'WSB_PHONE_NUMBER_ID', value: config.phoneNumberId, required: true, hint: '同一 API 测试页 → Phone number ID；填写数字 ID，不是手机号' },
    { name: 'WSB_APP_SECRET', value: config.appSecret, required: true, hint: '同一个 Meta App → App settings → Basic → App secret' },
    // Generated locally, so it is the one value that travels channel -> Meta.
    { name: 'WSB_VERIFY_TOKEN', value: config.verifyToken, required: true, generated: true, hint: '首次安装自动生成；Meta 回调验证时填写相同值，无需向 Meta 申请' }
  ];
  let error;
  try { validateReceiveConfig(config); } catch (cause) { error = cause.message; }
  const ready = !error;
  write(`[wsb] ${ready ? '本地配置检查通过；尚未验证 Meta 凭证有效性或真实收发。' : 'Channel 文件已就位，配置尚未完成。'}`);
  write(`[wsb] Channel 配置文件：${path.join(root, '.env')}`);
  write(`[wsb] Zylos 安装时收集的凭证保存在：${path.join(config.zylosDir, '.env')}`);
  for (const field of fields) {
    const status = field.value ? '已配置' : (field.required ? '待填写（必填）' : '未填写（当前 log 模式可选）');
    write(`[wsb] ${field.name}：${status}。${field.hint}`);
  }
  // The verify token is generated here and travels channel -> Meta, so the user
  // cannot look it up anywhere else; inbound POSTs are authenticated by the app
  // secret's HMAC, not by this value. Access token and app secret stay hidden.
  if (config.verifyToken) {
    write(`[wsb] Verify token（交给用户，粘贴进 Meta 回调页的「验证令牌 / Verify token」栏）：${config.verifyToken}`);
  }
  const wanted = fields.filter(field => field.required && !field.value && !field.generated);
  if (wanted.length) {
    write(`[wsb] 需要用户到 ${META_CONSOLE} 取下列值并提供给你：`);
    for (const field of wanted) write(`[wsb]   - ${field.name}：${field.hint}`);
    write('[wsb] 不需要 App ID；Phone number ID 是数字 ID，既不是手机号也不是 App ID 或 WABA ID。');
  }
  write(`[wsb] WSB_MODE=${config.mode}；WSB_PORT=${config.port}。演示通常保持 c4 和 47832。`);
  if (!ready) {
    write(`[wsb] 检查未通过：${error}`);
    write('[wsb] 编辑上面的 Channel .env：取消缺失项前面的 #，在等号后填值并保存；已配置项无需重填。不要用 .env.example 覆盖现有 .env。');
    write('[wsb] 填好后，在 Channel 目录运行 npm run check；通过后再启动或重启 Channel。');
  }
  return { ready, missing: fields.filter(field => field.required && !field.value).map(field => field.name) };
}
