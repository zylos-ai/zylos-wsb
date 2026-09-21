import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function buildEndpoint(message) {
  return `${message.from}|type:dm|msg:${message.id}`;
}

export function parseEndpoint(endpoint) {
  const [to, ...parts] = String(endpoint).split('|');
  if (!/^\d{5,20}$/.test(to)) throw new Error('Recipient must be an international WhatsApp number, digits only');
  const type = parts.find(part => part.startsWith('type:'));
  if (type && type !== 'type:dm') throw new Error('Only direct messages are supported');
  const replyTo = parts.find(part => part.startsWith('msg:'))?.slice(4);
  return { to, replyTo };
}

export function extractMessages(payload, phoneNumberId) {
  const messages = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (change?.field !== 'messages' || value?.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const item of Array.isArray(value.messages) ? value.messages : []) {
        if (typeof item?.id !== 'string' || !item.id || /[|\r\n\0]/.test(item.id)) continue;
        if (typeof item.from !== 'string' || !/^\d{5,20}$/.test(item.from)) continue;
        const contact = (Array.isArray(value.contacts) ? value.contacts : []).find(c => c?.wa_id === item.from);
        messages.push({
          id: item.id, from: item.from, name: String(contact?.profile?.name || ''),
          phoneNumberId, timestamp: String(item.timestamp || ''), type: String(item.type || 'unknown'),
          text: item.type === 'text' && typeof item.text?.body === 'string' ? item.text.body : '',
          raw: item
        });
      }
    }
  }
  return messages;
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export async function forwardToC4(config, message) {
  const content = `[WhatsApp Business customer] ${escapeXml(message.name || message.from)} said: ` +
    `<current-message>${escapeXml(message.text)}</current-message>`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [config.c4Receive,
      '--channel', 'wsb', '--endpoint', buildEndpoint(message), '--json', '--content', content
    ], { encoding: 'utf8', timeout: 35000, maxBuffer: 256 * 1024 }));
  } catch {
    // execFile's default error contains the entire argv, including customer text.
    throw new Error('C4 receive failed. Check the Zylos service and wsb skill installation.');
  }
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { throw new Error('C4 returned invalid JSON'); }
  if (result.ok !== true) throw new Error('C4 rejected the message');
}

export async function sendText(config, endpoint, text, fetchImpl = fetch) {
  if (text.trim() === '[SKIP]') return { skipped: true };
  if (!text.trim() || Array.from(text).length > 4096) throw new Error('Text must contain 1–4096 characters');
  if (!config.accessToken || !/^\d+$/.test(config.phoneNumberId)) {
    throw new Error('Set WSB_ACCESS_TOKEN and WSB_PHONE_NUMBER_ID before sending');
  }
  const { to, replyTo } = parseEndpoint(endpoint);
  const body = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'text', text: { body: text },
    ...(replyTo ? { context: { message_id: replyTo } } : {})
  };
  let response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('Meta request failed or timed out; delivery is unknown. Check WhatsApp before resending.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.error) {
    const code = Number(result?.error?.code) || response.status;
    const detail = code === 131047
      ? 'Customer service window expired; ask the customer to send a new message first.'
      : code === 190 ? 'Access token is invalid or expired.'
      : 'Check the token, phone number, account restriction and test recipient in Meta.';
    throw new Error(`Meta send failed (${code}). ${detail}`);
  }
  const id = result?.messages?.[0]?.id;
  if (!id) throw new Error('Meta response has no message ID');
  return { id };
}
