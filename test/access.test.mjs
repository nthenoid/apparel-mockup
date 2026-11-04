import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccessGuard } from '../server/access.js';

const team = 'myteam.cloudflareaccess.com';
const aud = 'abc123';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const fetchImpl = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

function token(claims, { kid = 'k1', key = privateKey } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', kid })}.${enc(claims)}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: `https://${team}`, aud: [aud], exp: now() + 600, email: 'a@b.com' });
const req = (t) => ({ headers: t ? { 'cf-access-jwt-assertion': t } : {} });

test('accepts a valid Access token', async () => {
  const check = createAccessGuard({ teamDomain: team, aud }, { fetchImpl });
  const r = await check(req(token(good())));
  assert.equal(r.ok, true);
  assert.equal(r.email, 'a@b.com');
});

test('rejects missing, expired, wrong-audience and forged tokens', async () => {
  const check = createAccessGuard({ teamDomain: team, aud }, { fetchImpl });
  assert.equal((await check(req())).ok, false);
  assert.equal((await check(req(token({ ...good(), exp: now() - 600 })))).ok, false);
  assert.equal((await check(req(token({ ...good(), aud: ['other'] })))).ok, false);
  assert.equal((await check(req(token({ ...good(), iss: 'https://evil.cloudflareaccess.com' })))).ok, false);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal((await check(req(token(good(), { key: other })))).ok, false);
  const t = token(good());
  const [h, , s] = t.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify({ ...good(), email: 'x@y.com' })).toString('base64url')}.${s}`;
  assert.equal((await check(req(tampered))).ok, false);
});
