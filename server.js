import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const STALE_AFTER_MS = Math.max(3000, Number(process.env.STALE_AFTER_MS || 10000));
let SERVER_TOKENS = {};
try { SERVER_TOKENS = JSON.parse(process.env.SERVER_TOKENS_JSON || '{}'); }
catch { console.error('SERVER_TOKENS_JSON is not valid JSON.'); process.exit(1); }

if (PASSWORD.length < 16 || SESSION_SECRET.length < 32) {
  console.error('Startup blocked: set DASHBOARD_PASSWORD (16+ chars) and SESSION_SECRET (32+ chars) in the environment.');
  process.exit(1);
}
if (!SERVER_TOKENS || Object.keys(SERVER_TOKENS).length === 0 || Object.values(SERVER_TOKENS).some(t => typeof t !== 'string' || t.length < 32)) {
  console.error('Startup blocked: SERVER_TOKENS_JSON must map each serverId to a unique token with 32+ characters.');
  process.exit(1);
}

const snapshots = new Map(); // in-memory only; no disk persistence of player positions
const secureCookie = process.env.NODE_ENV === 'production';

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://mc-heads.net data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...headers
  });
  res.end(data);
}

function safeEqual(a, b) {
  const aa = crypto.createHash('sha256').update(String(a)).digest();
  const bb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(aa, bb);
}

function sign(expires) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(expires)).digest('hex');
}

function hasSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('blockplan_session='));
  if (!raw) return false;
  const value = decodeURIComponent(raw.slice('blockplan_session='.length));
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const expires = value.slice(0, dot), signature = value.slice(dot + 1);
  if (!/^\d+$/.test(expires) || Number(expires) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signature, sign(expires));
}

function cookieHeader(req, expiresSeconds) {
  const expires = String(Math.floor(Date.now() / 1000) + expiresSeconds);
  const value = `${expires}.${sign(expires)}`;
  const parts = [`blockplan_session=${encodeURIComponent(value)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${expiresSeconds}`];
  if (secureCookie) parts.push('Secure');
  return parts.join('; ');
}

async function readBody(req, limit = 512_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function isValidPlayer(p) {
  return p && typeof p.uuid === 'string' && p.uuid.length <= 64 &&
    typeof p.name === 'string' && p.name.length <= 32 &&
    [p.x, p.y, p.z, p.yaw].every(v => typeof v === 'number' && Number.isFinite(v)) &&
    Math.abs(p.x) < 30_000_000 && Math.abs(p.z) < 30_000_000 && Math.abs(p.y) < 100_000;
}

function staticFile(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const normalized = path.normalize(pathname).replace(/^([/\\]*\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, normalized.replace(/^[/\\]+/, ''));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) return send(res, 403, 'Forbidden');
  let stat;
  try { stat = fs.statSync(file); } catch { return send(res, 404, 'Not found'); }
  if (!stat.isFile()) return send(res, 404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https://mc-heads.net data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

    if (req.method === 'POST' && url.pathname === '/api/v1/login') {
      const body = await readBody(req, 16_384);
      if (!safeEqual(body.password || '', PASSWORD)) return send(res, 401, { error: 'Falsches Passwort.' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 8 * 60 * 60) });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/logout') {
      const attrs = ['blockplan_session=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
      if (secureCookie) attrs.push('Secure');
      return send(res, 200, { ok: true }, { 'Set-Cookie': attrs.join('; ') });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/session') {
      const authenticated = hasSession(req);
      return send(res, 200, { authenticated, servers: authenticated ? Object.keys(SERVER_TOKENS) : [] });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/snapshot') {
      const auth = String(req.headers.authorization || '');
      const match = auth.match(/^Bearer\s+(.+)$/i);
      const body = await readBody(req, 512_000);
      const serverId = String(body.serverId || '');
      if (!Object.hasOwn(SERVER_TOKENS, serverId) || !match || !safeEqual(match[1], SERVER_TOKENS[serverId])) {
        return send(res, 401, { error: 'Unauthorized' });
      }
      if (!Array.isArray(body.players) || body.players.length > 250 || !body.players.every(isValidPlayer)) {
        return send(res, 400, { error: 'Invalid player snapshot' });
      }
      const players = body.players.map(p => ({
        uuid: p.uuid, name: p.name,
        x: p.x, y: p.y, z: p.z, yaw: p.yaw,
        dimension: typeof p.dimension === 'string' ? p.dimension.slice(0, 128) : 'unknown'
      }));
      snapshots.set(serverId, { serverId, updatedAt: new Date().toISOString(), receivedAtMs: Date.now(), players });
      return send(res, 200, { ok: true, received: players.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/players') {
      if (!hasSession(req)) return send(res, 401, { error: 'Login required' });
      const serverId = url.searchParams.get('serverId') || '';
      if (!Object.hasOwn(SERVER_TOKENS, serverId)) return send(res, 404, { error: 'Unknown serverId' });
      const snap = snapshots.get(serverId);
      if (!snap) return send(res, 200, { serverId, updatedAt: null, stale: true, players: [] });
      const stale = Date.now() - snap.receivedAtMs > STALE_AFTER_MS;
      return send(res, 200, { serverId, updatedAt: snap.updatedAt, stale, players: stale ? [] : snap.players });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method === 'GET' || req.method === 'HEAD') return staticFile(res, url.pathname);
    return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST, HEAD' });
  } catch (error) {
    if (error?.message === 'body_too_large') return send(res, 413, { error: 'Request too large' });
    if (error instanceof SyntaxError) return send(res, 400, { error: 'Malformed JSON' });
    console.error('Request failed:', error?.message || 'unknown error');
    return send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => console.log(`Blockplan Live backend listening on http://${HOST}:${PORT}`));
