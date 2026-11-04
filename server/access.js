// Verifies the signed token Cloudflare Access attaches to every request that
// passes its login. Requests without a valid token are rejected, so the tool
// stays locked even if someone reaches the container directly on your network.
import crypto from 'node:crypto';

const b64url = (s) => Buffer.from(s, 'base64url');

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function createAccessGuard({ teamDomain, aud, disabled }, { fetchImpl = fetch } = {}) {
  if (disabled) return async () => ({ ok: true, email: 'local-test' });

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const issuer = `https://${teamDomain}`;
  let keys = new Map();
  let fetchedAt = 0;
  let lastAttempt = 0;
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    lastAttempt = Date.now();
    inflight = (async () => {
      const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Access certs request failed: ${res.status}`);
      const body = await res.json();
      const next = new Map();
      for (const k of body.keys || []) {
        if (k.kty === 'RSA' && k.kid) next.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
      }
      if (!next.size) throw new Error('Access certs response had no keys');
      keys = next;
      fetchedAt = Date.now();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const deny = (reason) => ({ ok: false, reason });

  return async function check(req) {
    const token = req.headers['cf-access-jwt-assertion'] || readCookie(req.headers.cookie, 'CF_Authorization');
    if (!token) return deny('missing token');
    const parts = String(token).split('.');
    if (parts.length !== 3) return deny('malformed token');

    let header, payload;
    try {
      header = JSON.parse(b64url(parts[0]).toString('utf8'));
      payload = JSON.parse(b64url(parts[1]).toString('utf8'));
    } catch {
      return deny('malformed token');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return deny('unsupported token');

    const stale = Date.now() - fetchedAt > 60 * 60 * 1000;
    const unknownKid = !keys.has(header.kid);
    // Refresh at most once a minute so bad tokens can't hammer Cloudflare.
    if ((stale || unknownKid) && (keys.size === 0 || Date.now() - lastAttempt > 60 * 1000)) {
      try {
        await refresh();
      } catch {
        if (!keys.size) return deny('cannot load signing keys');
      }
    }
    const key = keys.get(header.kid);
    if (!key) return deny('unknown signing key');

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    let valid = false;
    try {
      valid = crypto.verify('RSA-SHA256', signed, key, b64url(parts[2]));
    } catch {
      valid = false;
    }
    if (!valid) return deny('bad signature');

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now - 30) return deny('expired');
    if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return deny('not yet valid');
    if (payload.iss !== issuer) return deny('wrong issuer');
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return deny('wrong audience');

    return { ok: true, email: typeof payload.email === 'string' ? payload.email : '' };
  };
}
