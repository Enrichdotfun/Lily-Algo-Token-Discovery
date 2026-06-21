// Public read API. Serves the daemons' persisted board (SQLite, snapshot
// fallback) with USD enrichment, a short response cache, CORS, optional API
// keys and a simple per-minute rate limit.
//
// The expensive on-chain work is done once by the daemons; every request here
// just reads precomputed data, so this scales to many consumers cheaply.
import http from 'node:http';
import { config } from '../discovery/lib/config.mjs';
import { readSnapshot, writeSnapshot } from '../discovery/lib/store.mjs';
import { getCoin } from '../discovery/lib/pumpfun.mjs';
import { getSolUsd } from '../discovery/lib/solprice.mjs';
import { getCoins, getFeedMeta } from '../discovery/lib/db.mjs';

const FEEDS = {
  old: { file: 'old.json', freshMs: config.old.activeMs * 2 },
  bonded: { file: 'bonded.json', freshMs: config.bonded.trackMs },
  new: { file: 'new.json', freshMs: config.newPairs.trackMs },
};

const API_KEYS = new Set(config.apiKeys.split(',').map((s) => s.trim()).filter(Boolean));
const metaCache = readSnapshot('token-meta.json') || {};

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-api-key, content-type',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// --- usage controls -------------------------------------------------------
function authed(req, url) {
  if (!API_KEYS.size) return true; // open if no keys configured
  const k = req.headers['x-api-key'] || url.searchParams.get('key');
  return !!k && API_KEYS.has(k);
}
const buckets = new Map();
function rateOk(id) {
  const now = Date.now();
  let b = buckets.get(id);
  if (!b || now - b.start >= 60_000) { b = { start: now, count: 0 }; buckets.set(id, b); }
  b.count++;
  return b.count <= config.rateLimitPerMin;
}

// --- data assembly (cached ~2s) ------------------------------------------
function enrichCoin(c, solUsd) {
  return {
    ...c,
    marketCapUsd: c.marketCapUsd ?? (c.marketCapSol != null && solUsd ? c.marketCapSol * solUsd : null),
    athMcapUsd: c.athMcapSol != null && solUsd ? c.athMcapSol * solUsd : null,
    volumeUsd: c.volumeSol != null && solUsd ? c.volumeSol * solUsd : null,
  };
}
const cache = new Map();
async function buildFeed(feed) {
  const hit = cache.get(feed);
  if (hit && Date.now() - hit.at < 2000) return hit.body;
  const def = FEEDS[feed];
  let coins = getCoins(feed, def.freshMs);
  let meta = getFeedMeta(feed);
  if ((!coins || !coins.length) && !meta) { // DB cold — fall back to the snapshot file
    const snap = readSnapshot(def.file);
    if (snap) { coins = snap.coins || []; meta = snap; }
  }
  const solUsd = await getSolUsd();
  const body = {
    updatedAt: meta?.updatedAt ?? 0,
    ws: meta?.ws,
    api: meta?.api,
    stats: meta?.stats,
    scanner: meta?.scanner,
    solUsd,
    coins: (coins || []).map((c) => enrichCoin(c, solUsd)),
  };
  cache.set(feed, { at: Date.now(), body });
  return body;
}

async function resolveMeta(mints) {
  const out = {};
  const missing = [];
  for (const m of mints) (metaCache[m] ? (out[m] = metaCache[m]) : missing.push(m));
  for (const m of missing.slice(0, 25)) {
    try {
      const c = await getCoin(m);
      out[m] = metaCache[m] = { name: c?.name ?? null, symbol: c?.symbol ?? null, image: c?.image ?? null };
    } catch { out[m] = { name: null, symbol: null, image: null }; }
  }
  writeSnapshot('token-meta.json', metaCache);
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (p === '/api/health') return send(res, 200, { ok: true, time: Date.now() });

    // rate limit + auth for everything else
    const id = (req.headers['x-api-key'] || url.searchParams.get('key') || req.socket.remoteAddress || 'anon');
    if (!rateOk(id)) return send(res, 429, { error: 'rate limit exceeded' });
    if (!authed(req, url)) return send(res, 401, { error: 'invalid or missing api key' });

    if (p === '/api/old') return send(res, 200, await buildFeed('old'));
    if (p === '/api/bonded') return send(res, 200, await buildFeed('bonded'));
    if (p === '/api/new') return send(res, 200, await buildFeed('new'));

    if (p === '/api/token-meta') {
      const mints = (url.searchParams.get('mints') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
      return send(res, 200, { meta: await resolveMeta(mints) });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(config.port, () => {
  console.log(`[api] http://localhost:${config.port}  keys:${API_KEYS.size ? 'on' : 'off'}  rate:${config.rateLimitPerMin}/min`);
  console.log('      /api/old /api/new /api/bonded /api/token-meta /api/health');
});
