import path from 'node:path';
import { ROOT, validateReceiveConfig } from './config.js';

export function printConfigurationGuide(config, { root = ROOT, write = console.log } = {}) {
  const fields = [
    { name: 'WSB_ACCESS_TOKEN', value: config.accessToken, required: config.mode !== 'log', hint: 'Meta App → WhatsApp API 测试页 → Access token（访问令牌）' },
    { name: 'WSB_PHONE_NUMBER_ID', value: config.phoneNumberId, required: true, hint: '同一 API 测试页 → Phone number ID；填写数字 ID，不是手机号' },
    { name: 'WSB_APP_SECRET', value: config.appSecret, required: true, hint: '同一个 Meta App → App settings → Basic → App secret' },
    { name: 'WSB_VERIFY_TOKEN', value: config.verifyToken, required: true, hint: '首次安装自动生成；Meta 回调验证时填写相同值，无需向 Meta 申请' }
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
  write(`[wsb] WSB_MODE=${config.mode}；WSB_PORT=${config.port}。演示通常保持 c4 和 47832。`);
  if (!ready) {
    write(`[wsb] 检查未通过：${error}`);
    write('[wsb] 编辑上面的 Channel .env：取消缺失项前面的 #，在等号后填值并保存；已配置项无需重填。不要用 .env.example 覆盖现有 .env。');
    write('[wsb] 填好后，在 Channel 目录运行 npm run check；通过后再启动或重启 Channel。');
  }
  return { ready, missing: fields.filter(field => field.required && !field.value).map(field => field.name) };
}
