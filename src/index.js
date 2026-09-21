import path from 'node:path';
import { getConfig, loadEnvironment, validateReceiveConfig } from './config.js';
import { createWebhookServer } from './server.js';

try {
  loadEnvironment();
  const config = getConfig();
  validateReceiveConfig(config);
  const server = createWebhookServer(config);
  server.on('error', error => { console.error(`[wsb] ${error.code || 'Server error'}`); process.exitCode = 1; });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[wsb] Mode: ${config.mode}`);
    console.log(`[wsb] Webhook: http://127.0.0.1:${config.port}/whatsapp/webhook`);
    console.log(`[wsb] Messages: ${path.join(config.dataDir, 'messages.ndjson')}`);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 40000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(`[wsb] ${error.message}`);
  process.exitCode = 1;
}
