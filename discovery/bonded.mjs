// ---------------------------------------------------------------------------
// BONDED (postbond) discovery + gate
//
// Streams pump.fun migrations (coins that "bond" / graduate to an AMM), then
// tracks each one's market cap, all-time-high and drawdown live off the trade
// tape. It applies four gates and hides anything that trips one:
//
//   bundle      — too few opening txns (forced/bundled launch)
//   holder-rug  — whale-float or creator-retention from on-chain holders
//   early-dump  — first-minute return AND net flow both deeply negative
//   crater      — drawn down past the crater threshold (dead coin)
//
// Clean survivors are surfaced with live mcap / dip% / age so you can watch a
// fresh graduate without manually filtering out the obvious rugs.
// ---------------------------------------------------------------------------
import { config } from './lib/config.mjs';
import { PumpPortal } from './lib/pumpportal.mjs';
import { makeRpc, bondingCurvePda, launchTxnStats, mineHolders } from './lib/rpc.mjs';
import { bundleVerdict, holderVerdict, isCratered, THRESHOLDS } from './lib/gates.mjs';
import { getCoin } from './lib/pumpfun.mjs';
import { getDexMcap } from './lib/dex.mjs';
import { writeSnapshot } from './lib/store.mjs';
import { load } from './lib/metrics.mjs';
import { persist, getCoins } from './lib/db.mjs';

const B = config.bonded;
const rpc = makeRpc(config.rpcUrl);
const board = new Map();
let stats = { messages: 0, bondsSeen: 0 };
let wsState = 'connecting';

function hideReason(c) {
  if (c.bundled) return 'bundle';
  if (c.rugFake) return c.rugReason || 'holder-rug';
  if (c.earlyDumped) return 'early-dump';
  if (isCratered(c.dipPct)) return 'crater';
  return null;
}

// "stale" = a DEAD coin: cratered, or its mcap has fallen below the floor. NOT
// based on age — a good coin stays Tradable (with live mcap) however long it lives.
function staleVerdict(c) {
  if (isCratered(c.dipPct)) return true;
  if (c.marketCapUsd != null && c.marketCapUsd < B.staleMcUsd) return true;
  return false;
}

function flush() {
  const now = Date.now();
  for (const [mint, c] of board) {
    if (now - c.bondedAt > B.staleMs) { board.delete(mint); portal.unwatchTrades(mint); continue; } // hard keep-window cap
    c.stale = staleVerdict(c); // dead coin (cratered / below mcap floor) -> Stale; good coins stay Tradable
  }
  const rows = [...board.values()].map((c) => {
    const hr = hideReason(c);
    return {
      mint: c.mint,
      name: c.name,
      symbol: c.symbol,
      bondedAt: c.bondedAt,
      ageMs: now - c.bondedAt,
      trades: c.trades,
      volumeSol: c.volumeSol,
      athMcapSol: c.athLevel,
      lastMcapSol: c.lastLevel,
      marketCapSol: c.lastLevel,
      marketCapUsd: c.marketCapUsd ?? null,
      dipPct: c.dipPct,
      maxDipPct: c.maxDipPct,
      reached: c.reached,
      launchTxns: c.launchTxns,
      maxPerSlot: c.maxPerSlot ?? null,
      checked: c.checked,
      bundled: c.bundled,
      rugFake: c.rugFake,
      rugReason: c.rugReason,
      earlyDumped: c.earlyDumped,
      holderTop1: c.holderTop1,
      holderTop10: c.holderTop10,
      creatorPct: c.creatorPct,
      hidden: hr != null,
      hideReason: hr,
      stale: !!c.stale,
    };
  });
  const blocked = rows.filter((r) => r.hidden).length;
  const sorted = rows.sort((a, b) => b.bondedAt - a.bondedAt);
  const meta = {
    updatedAt: now, ws: wsState, api: load(), thresholds: THRESHOLDS,
    stats: { ...stats, tracking: board.size, blocked, surfaced: rows.length - blocked },
  };
  writeSnapshot('bonded.json', { ...meta, coins: sorted });
  persist('bonded', sorted, meta);
}

async function gateCoin(c) {
  if (c.gating) return;
  c.gating = true;
  c.lastGate = Date.now();
  try {
    const meta = await getCoin(c.mint).catch(() => null);
    c.name = c.name || meta?.name || null;
    c.symbol = c.symbol || meta?.symbol || null;
    applyMcap(c, await mcapUsdFor(c.mint, meta)); // live AMM mcap (DexScreener), USD
    const pda = bondingCurvePda(c.mint);
    const launch = await launchTxnStats(rpc, pda, 20).catch(() => null);
    if (launch) { c.launchTxns = launch.count; c.maxPerSlot = launch.maxPerSlot; }
    const holders = await mineHolders(rpc, c.mint, meta?.creator).catch(() => ({}));
    c.holderTop1 = holders.holderTop1 ?? null;
    c.holderTop10 = holders.holderTop10 ?? null;
    c.creatorPct = holders.creatorPct ?? null;
    // bundle only matters while the coin is young + still concentrated
    if (bundleVerdict({ maxPerSlot: c.maxPerSlot, lifetimeTxns: c.launchTxns, holderTop1: c.holderTop1 })) {
      c.bundled = true; c.bundleReason = 'launch-slot-cluster';
    }
    const hv = holderVerdict({ creatorPct: c.creatorPct, holderTop1: c.holderTop1 });
    if (hv) { c.rugFake = true; c.rugReason = hv; }
  } catch { /* leave flags as-is */ }
  finally {
    c.gating = false;
    // "checked" once the holder gate actually returned data (the key rug signal).
    // Until then a coin is NOT eligible for the Tradable tab.
    c.checked = c.holderTop1 != null;
  }
  flush();
}

// Post-migration trades don't come through subscribeTokenTrade, so the live trade
// tape (onTrade) is empty for bonded coins — mcap/dip come from a periodic refresh.
// We read the LIVE AMM mcap from DexScreener (USD), falling back to pump.fun only
// when the pool isn't indexed yet. pump.fun's own market_cap is the frozen bonding
// curve value AND its API is blocked from datacenter IPs, so it can't be trusted
// post-bond. See lib/dex.mjs.
async function mcapUsdFor(mint, meta) {
  const dex = await getDexMcap(mint).catch(() => null);
  if (dex?.marketCapUsd != null) return dex.marketCapUsd;
  return meta?.marketCapUsd ?? null; // fallback: pump.fun (only useful pre-index)
}

// dip/ath are tracked in USD here (a ratio, so the unit just has to be consistent).
function applyMcap(c, mcUsd) {
  c.mcapAt = Date.now();
  if (mcUsd == null) return;
  c.marketCapUsd = mcUsd;
  if (c.firstLevel == null) c.firstLevel = mcUsd;
  if (c.athLevel == null || mcUsd > c.athLevel) c.athLevel = mcUsd;
  c.lastLevel = mcUsd;
  c.dipPct = c.athLevel ? (mcUsd / c.athLevel - 1) * 100 : 0;
  if (c.dipPct < c.maxDipPct) c.maxDipPct = c.dipPct;
}

async function refreshMcap(c) {
  c.mcapAt = Date.now();
  applyMcap(c, await mcapUsdFor(c.mint, null));
}

// Post-migration AMM trades rarely stream through subscribeTokenTrade, and a stray
// one carries a SOL-denominated mcap that would corrupt the USD-based dip/ath. So
// only count activity here; mcap/dip/ath come exclusively from the DexScreener
// refresh (applyMcap), which is the single source of truth for a bonded coin.
function onTrade(c, m) {
  c.trades++;
  c.lastTradeAt = Date.now();
  c.volumeSol += m.solAmount || 0;
}

const portal = new PumpPortal({
  url: config.wsUrl,
  migration: true,
  onState: (s) => { wsState = s; },
  onMessage: (m) => {
    stats.messages++;
    const mint = m.mint;
    if (!mint) return;

    // A migration event marks a bond. PumpPortal flags it via txType 'migrate'
    // (older payloads used a 'pool' field); accept either.
    const isMigration = m.txType === 'migrate' || m.pool || m.txType === 'migration';
    if (isMigration && !board.has(mint)) {
      stats.bondsSeen++;
      const c = {
        mint, name: m.name ?? null, symbol: m.symbol ?? null,
        bondedAt: Date.now(), lastTradeAt: Date.now(), trades: 0, volumeSol: 0,
        firstLevel: null, athLevel: null, lastLevel: null,
        dipPct: 0, maxDipPct: 0, reached: { d30: false, d40: false, d60: false },
        launchTxns: null, bundled: false, rugFake: false, rugReason: null,
        holderTop1: null, creatorPct: null,
        checked: false, gating: false, lastGate: 0,
        earlyClosed: false, earlyNet: 0, earlyEndLevel: null, earlyDumped: false,
      };
      board.set(mint, c);
      portal.watchTrades(mint);
      gateCoin(c);
      return;
    }

    if (m.txType === 'buy' || m.txType === 'sell') {
      const c = board.get(mint);
      if (c) onTrade(c, m);
    }
  },
});

// Rehydrate the board from the last persisted snapshot so a restart/redeploy
// doesn't drop live tracking (the periodic loops below then refresh mcap and
// re-gate as needed). Without this, every redeploy leaves stale rows behind.
function hydrate(row, now) {
  return {
    mint: row.mint, name: row.name ?? null, symbol: row.symbol ?? null,
    bondedAt: row.bondedAt ?? now, lastTradeAt: now,
    trades: row.trades ?? 0, volumeSol: row.volumeSol ?? 0,
    firstLevel: null, athLevel: row.athMcapSol ?? null, lastLevel: row.lastMcapSol ?? null,
    marketCapUsd: row.marketCapUsd ?? null,
    dipPct: row.dipPct ?? 0, maxDipPct: row.maxDipPct ?? 0,
    reached: row.reached ?? { d30: false, d40: false, d60: false },
    launchTxns: row.launchTxns ?? null,
    bundled: !!row.bundled, rugFake: !!row.rugFake, rugReason: row.rugReason ?? null,
    earlyDumped: !!row.earlyDumped,
    holderTop1: row.holderTop1 ?? null, holderTop10: row.holderTop10 ?? null, creatorPct: row.creatorPct ?? null,
    checked: !!row.checked, gating: false, lastGate: 0, mcapAt: 0,
    earlyClosed: true, earlyNet: 0, earlyEndLevel: null, stale: !!row.stale,
  };
}
try {
  const now = Date.now();
  let n = 0;
  for (const row of getCoins('bonded', B.staleMs)) {
    if (!row?.mint || board.has(row.mint) || now - (row.bondedAt ?? 0) > B.staleMs) continue;
    board.set(row.mint, hydrate(row, now));
    n++;
  }
  console.log(`[bonded] rehydrated ${n} coins from db`);
} catch (e) { console.log('[bonded] rehydrate skipped:', e?.message); }

console.log('[bonded] streaming migrations from', config.wsUrl);
portal.start();
for (const c of board.values()) if (!c.stale) portal.watchTrades(c.mint); // resume tape for active (non-stale) hydrated coins
flush();
setInterval(flush, 4000);

// Retry the gate for any coin that hasn't resolved yet (fresh AMM pools can take
// a bit to be indexable), so coins don't sit unchecked forever.
setInterval(() => {
  const now = Date.now();
  for (const c of board.values()) {
    if (!c.checked && !c.gating && !c.stale && now - (c.lastGate || 0) > 15000) gateCoin(c);
  }
}, 8000);

// Keep mcap/dip current. Good (tradable) coins refresh fast (~8s) so their mcaps
// are live — the set is small, so this is cheap. Dead/stale coins refresh slowly
// (~5min, just to catch a recovery). Blocked coins aren't refreshed. Oldest-first
// + a per-tick cap bound the API cost.
setInterval(() => {
  const now = Date.now();
  const due = [...board.values()]
    .filter((c) => {
      if (!c.checked || c.gating || hideReason(c) != null) return false;
      const interval = c.stale ? 300_000 : 8_000;
      return now - (c.mcapAt || 0) > interval;
    })
    .sort((a, b) => (a.mcapAt || 0) - (b.mcapAt || 0))
    .slice(0, 40);
  for (const c of due) refreshMcap(c);
}, 4000);
