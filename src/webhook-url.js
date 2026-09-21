import fs from 'node:fs';
import path from 'node:path';

export function getWebhookInfo({ zylosDir, port }) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read Zylos .zylos/config.json; check its JSON and permissions.');
  }
  if (!settings?.domain) return { url: null, reason: 'No public domain configured in Zylos. For local testing run sh start-ngrok.sh and append /whatsapp/webhook to its HTTPS URL.' };
  if (settings.protocol && settings.protocol !== 'https') {
    return { url: null, reason: 'Zylos uses HTTP. Meta requires a public HTTPS callback; enable HTTPS in Zylos or use ngrok for local testing.' };
  }
  let origin;
  try {
    origin = new URL(`https://${settings.domain}`);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.port || /[\s/\\?#@]/.test(settings.domain)) throw new Error();
  } catch {
    throw new Error('Invalid Zylos domain; expected a hostname without a scheme, path or port.');
  }
  const host = origin.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { url: null, reason: 'Zylos needs a public HTTPS domain for Meta. For local testing run sh start-ngrok.sh.' };
  }
  let caddy = '';
  try { caddy = fs.readFileSync(path.join(zylosDir, 'http', 'Caddyfile'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read the Zylos Caddyfile; check its permissions.'); }
  const block = caddy.match(/# BEGIN zylos-component:wsb\s*\n([\s\S]*?)# END zylos-component:wsb\b/)?.[1] || '';
  const managedRoute = /\bhandle\s+\/whatsapp\/webhook\s*\{/.test(block)
    && new RegExp(`\\breverse_proxy\\s+(?:localhost|127\\.0\\.0\\.1):${port}(?=\\s|$)`).test(block);
  return { url: `${origin.origin}/whatsapp/webhook`, managedRoute };
}

export function printWebhookInfo(config) {
  const info = getWebhookInfo(config);
  if (!info.url) {
    console.log(`[wsb] ${info.reason}`);
  } else {
    console.log(`[wsb] Callback URL: ${info.url}`);
    console.log(info.managedRoute
      ? '[wsb] Zylos managed route found. Start the service, then verify and save this URL in Meta.'
      : `[wsb] Matching Zylos route not found. Install with zylos add, or proxy /whatsapp/webhook to http://127.0.0.1:${config.port}/whatsapp/webhook with your HTTPS server.`);
    console.log('[wsb] URL is derived from Zylos settings; DNS, TLS and external reachability have not been tested.');
  }
  console.log('[wsb] Meta Verify token: use WSB_VERIFY_TOKEN from the channel .env (or Zylos .env if inherited).');
  return info;
}
