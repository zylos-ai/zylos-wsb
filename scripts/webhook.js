#!/usr/bin/env node
import { loadEnvironment, getConfig } from '../src/config.js';
import { printWebhookInfo } from '../src/webhook-url.js';

try {
  loadEnvironment();
  printWebhookInfo(getConfig());
} catch (error) {
  console.error(`[wsb] ${error.message}`);
  process.exitCode = 1;
}
