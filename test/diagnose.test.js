import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { diagnose, explain, redact } from '../scripts/diagnose.js';

const base = getConfig({
  WSB_PHONE_NUMBER_ID: '123456789', WSB_APP_SECRET: 'test-secret-value',
  WSB_VERIFY_TOKEN: 'test-verify', WSB_ACCESS_TOKEN: 'EAAsecret-access-token'
});

const reply = (status, body) => async () => ({
  ok: status < 400, status, json: async () => body
});

test('a valid token reports the business number and never echoes the credential', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ id: '123456789', verified_name: 'Acme Ltd' }) };
  };
  const result = await diagnose(base, fetchImpl);
  assert.equal(result.ok, true);
  assert.match(explain(result), /valid.*Acme Ltd/);
  // The token travels in the Authorization header only — never in an argv, and
  // never in anything this script prints.
  assert.equal(calls[0].url, 'https://graph.facebook.com/v25.0/123456789');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${base.accessToken}`);
  assert.equal(JSON.stringify(result).includes(base.accessToken), false);
});

test('an expired token is named as a token problem, not an allow-list problem', async () => {
  const result = await diagnose(base, reply(401, { error: { code: 190, message: 'Session has expired' } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 190);
  assert.match(explain(result), /invalid or expired/);
  assert.match(explain(result), /allow-list is not involved/);
});

test('an unreachable Graph API is reported as untested, not as an invalid token', async () => {
  const result = await diagnose(base, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(result.reachable, false);
  assert.match(explain(result), /not tested, not proven bad/);
});

test('a credential echoed back by Meta is stripped from the output', async () => {
  const result = await diagnose(base, reply(400, {
    error: { code: 100, message: `Invalid OAuth access token: ${base.accessToken}` }
  }));
  assert.equal(result.message.includes(base.accessToken), false);
  assert.match(result.message, /<redacted>/);
});

test('redaction ignores values too short to be secrets', () => {
  assert.equal(redact('port 8080 failed', ['8080']), 'port 8080 failed');
  assert.equal(redact('token abcdefghij here', ['abcdefghij']), 'token <redacted> here');
});

test('diagnose refuses to run without the values it would test', async () => {
  await assert.rejects(() => diagnose({ ...base, accessToken: '' }), /WSB_ACCESS_TOKEN/);
});
