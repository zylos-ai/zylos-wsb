#!/usr/bin/env node
// Read-only credential check against Meta: is this token still valid for this
// phone number?
//
// Replaces the shell snippet TROUBLESHOOTING.md used to recommend
// (`set -a && . .env && set +a` then curl -H "Authorization: Bearer $TOKEN").
// That snippet had two problems: sourcing .env executes it as shell, so a `$`
// or backtick in a credential runs as code; and a token expanded into a curl
// argv is readable in /proc by every process on the box for the life of the
// call. This loads the same values through the project's own loader and never
// puts a secret on a command line.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvironment, getConfig } from '../src/config.js';

// Meta echoes request context in some error messages. Nothing should carry a
// credential out of this process, so strip them from anything printed.
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.replaceAll(secret, '<redacted>');
  }
  return out;
}

export async function diagnose(config, fetchImpl = fetch) {
  if (!config.accessToken || !/^\d+$/.test(config.phoneNumberId)) {
    throw new Error('Set WSB_ACCESS_TOKEN and WSB_PHONE_NUMBER_ID before running diagnose');
  }
  const secrets = [config.accessToken, config.appSecret];
  let response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}`, {
      redirect: 'error',
      headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    // Unreachable is not the same as invalid; say so rather than blaming the token.
    return { reachable: false, ok: false, status: 0, code: null, message: '', displayName: '' };
  }
  const result = await response.json().catch(() => null);
  return {
    reachable: true,
    ok: response.ok && !result?.error,
    status: response.status,
    code: Number(result?.error?.code) || null,
    message: redact(result?.error?.message, secrets),
    displayName: redact(result?.verified_name || result?.display_phone_number || '', secrets)
  };
}

// Same code table as docs/TROUBLESHOOTING.md; a read call cannot fail on the
// recipient allow-list, so a 190 here is unambiguously the token.
export function explain(result) {
  if (!result.reachable) return 'Could not reach graph.facebook.com. Network or proxy problem — the token was not tested, not proven bad.';
  if (result.ok) return `Token and phone number are valid${result.displayName ? ` (${result.displayName})` : ''}.`;
  if (result.code === 190) return 'Token is invalid or expired. This is a read-only call, so the recipient allow-list is not involved.';
  if (result.code === 100) return 'Phone Number ID is not valid for this token, or the token lacks access to it.';
  return `Meta rejected the call (HTTP ${result.status}${result.code ? `, code ${result.code}` : ''}).`;
}

export async function main() {
  loadEnvironment();
  const config = getConfig();
  const result = await diagnose(config);
  console.log(`[wsb] ${explain(result)}`);
  if (result.message) console.log(`[wsb] Meta said: ${result.message}`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[wsb] ${error.message}`); process.exitCode = 1; });
}
