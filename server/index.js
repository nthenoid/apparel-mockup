import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfig, ssEnabled } from './config.js';
import { createAccessGuard } from './access.js';
import { getCatalog, getStatus, startSyncSchedule, searchStyles, addStyle, removeStyle, listJobs, ensurePhoto } from './catalog.js';
import { convertVector, UserError } from './convert.js';
import { demoSvg } from './demo.js';
import { readOverrides, applyOverride } from './overrides.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limitBytes) return reject(new UserError('That file is too large.', 413));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new UserError('That file is too large.', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// JSON bodies only: browsers won't send this content type cross-site without
// asking first, which keeps other websites from making changes here.
async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new UserError('Expected JSON.', 415);
  const body = await readBody(req, 16 * 1024);
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new UserError('Expected JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new UserError('Expected a JSON object.');
  return parsed;
}

async function serveFile(res, root, rel, cache) {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!full.startsWith(root + path.sep)) return send(res, 404, 'Not found');
  const type = MIME[path.extname(full).toLowerCase()];
  if (!type) return send(res, 404, 'Not found');
  try {
    const s = await stat(full);
    if (!s.isFile()) return send(res, 404, 'Not found');
    const body = await readFile(full);
    send(res, 200, body, { 'Content-Type': type, 'Cache-Control': cache });
  } catch {
    send(res, 404, 'Not found');
  }
}

assertConfig();
const checkAccess = createAccessGuard(config.access);
const imagesRoot = path.resolve(config.dataDir, 'images');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    const auth = await checkAccess(req);
    if (!auth.ok) {
      return send(res, 403, 'Access denied. Open this tool through its Cloudflare address so you can sign in.', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, {
        maxPrintWidthIn: config.maxPrintWidthIn,
        maxPrintHeightIn: config.maxPrintHeightIn,
        maxUploadMb: config.maxUploadMb,
        ssConfigured: ssEnabled(),
        status: getStatus(),
        user: auth.email,
      });
    }
    if (req.method === 'GET' && p === '/api/catalog') return json(res, 200, await getCatalog());
    if (req.method === 'GET' && p === '/api/overrides') return json(res, 200, await readOverrides());

    if (req.method === 'POST' && p === '/api/overrides') return json(res, 200, await applyOverride(await readJson(req)));

    if (req.method === 'GET' && p === '/api/styles/search') return json(res, 200, { results: await searchStyles(url.searchParams.get('q')) });
    if (req.method === 'GET' && p === '/api/styles/jobs') return json(res, 200, { jobs: listJobs() });
    if (req.method === 'POST' && p === '/api/styles/add') return json(res, 202, await addStyle((await readJson(req)).styleID));
    if (req.method === 'POST' && p === '/api/styles/remove') return json(res, 200, await removeStyle((await readJson(req)).id));

    if (req.method === 'POST' && p === '/api/convert') {
      const body = await readBody(req, config.maxUploadMb * 1024 * 1024);
      const png = await convertVector(body);
      return send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    }

    if (req.method === 'GET' && p.startsWith('/demo/')) {
      const m = p.match(/^\/demo\/(tee|hoodie|tank)-(front|back)-([0-9a-f]{6})\.svg$/i);
      const svg = m && demoSvg(m[1].toLowerCase(), m[2].toLowerCase(), m[3]);
      if (!svg) return send(res, 404, 'Not found');
      return send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    }

    if (req.method === 'GET' && p.startsWith('/img/ss/')) {
      // Garment photos download from S&S the first time a color is picked.
      if (!(await ensurePhoto(p.slice(8)))) return send(res, 404, 'Not found');
      return serveFile(res, imagesRoot, p.slice(5), 'private, max-age=604800');
    }
    if (req.method === 'GET' && p.startsWith('/img/')) return serveFile(res, imagesRoot, p.slice(5), 'private, max-age=604800');

    if (req.method === 'GET' || req.method === 'HEAD') return serveFile(res, publicDir, p === '/' ? 'index.html' : p.slice(1), 'no-cache');

    send(res, 405, 'Method not allowed');
  } catch (err) {
    if (err instanceof UserError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Something went wrong on the server. Check the container log.' });
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.listen(config.port, () => {
  console.log(`Mockup tool listening on port ${config.port}${config.access.disabled ? ' (Access check OFF: local testing only)' : ''}`);
  startSyncSchedule();
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
