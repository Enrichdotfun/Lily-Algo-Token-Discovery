// ---------------------------------------------------------------------------
// NEW PAIRS discovery + gate
//
// Streams fresh pump.fun launches (subscribeNewToken) and tracks each on the
// live trade tape (pre-bond trades DO stream through subscribeTokenTrade).
// Applies the SAME gates as the bonded feed -- bundle / holder-rug / early-dump
// / crater -- so coins flow Unchecked -> Blocked or Tradable, exactly like Bonded.
//
// Launches are a firehose, so cost is controlled two ways:
//   * we only WATCH up to maxWatch coins at once (rolling; no-traction coins are
//     pruned to free slots), and
//   * we only spend RPC GATING coins that show real traction (>= minTradesToGate).
//
// A coin leaves this feed when it bonds -- it then appears in the Bonded feed.
// ---------------------------------------------------------------------------
import { config } from './lib/config.mjs';
import { PumpPortal } from './lib/pumpportal.mjs';
import { makeRpc, bondingCurvePda, launchTxnStats, mineHolders } from './lib/rpc.mjs';
import { holderVerdict, earlyDumpVerdict, isCratered, THRESHOLDS } from './lib/gates.mjs';
import { getCoin } from './lib/pumpfun.mjs';
import { writeSnapshot } from './lib/store.mjs';
import { load } from './lib/metrics.mjs';
import { persist, getCoins } from './lib/db.mjs';

const N = config.newPairs;
const rpc = makeRpc(config.rpcUrl);
const board = new Map();
let stats = { messages: 0, launchesSeen: 0, gated: 0 };
let wsState = 'connecting';

function hideReason(c) {
  if (c.bundled) return 'bundle';
  if (c.rugFake) return c.rugReason || 'holder-rug';
  if (c.earlyDumped) return 'early-dump';
  if (isCratered(c.dipPct)) return 'crater';
  return null;
}

function applyMcap(c, meta) {
  c.mcapAt = Date.now();
  if (!meta) return;
  if (meta.bonded) c.bonded = true; // graduated -> hand off to the Bonded feed
  if (meta.marketCapUsd != null) c.marketCapUsd = meta.marketCapUsd;
  const level = meta.marketCapSol;
  if (level == null) return;
  if (c.firstLevel == null) c.firstLevel = level;
  if (c.athLevel == null || level > c.athLevel) c.athLevel = level;
  c.lastLevel = level;
  if (c.athLevel) {
    c.dipPct = (level / c.athLevel - 1) * 100;
    if (c.dipPct < c.maxDipPct) c.maxDipPct = c.dipPct;
  }
}

async function refreshMcap(c) {
  c.mcapAt = Date.now();
  applyMcap(c, await getCoin(c.mint).catch(() => null));
}

function onTrade(c, m) {
  c.trades++;
  c.lastTradeAt = Date.now();
  c.volumeSol += m.solAmount || 0;
  const level = m.marketCapSol;
  if (level != null) {
    if (c.firstLevel == null) c.firstLevel = level;
    if (c.athLevel == null || level > c.athLevel) c.athLevel = level;
    c.lastLevel = level;
    c.dipPct = c.athLevel ? (level / c.athLevel - 1) * 100 : 0;
    if (c.dipPct < c.maxDipPct) c.maxDipPct = c.dipPct;
  }
  // early-window strength: net flow + return over the first minute after launch
  if (!c.earlyClosed) {
    c.earlyNet += (m.txType === 'buy' ? (m.solAmount || 0) : -(m.solAmount || 0));
    if (level != null) c.earlyEndLevel = level;
    if (Date.now() - c.launchedAt >= N.earlyWindowMs) {
      c.earlyClosed = true;
      const ret = c.firstLevel ? (c.earlyEndLevel / c.firstLevel - 1) * 100 : 0;
      if (earlyDumpVerdict({ earlyReturnPct: ret, earlyNetSol: c.earlyNet })) {
        c.earlyDumped = true;
        c.earlyReturnPct = ret;
      }
    }
  }
}

async function gateCoin(c) {
  if (c.gating) return;
  c.gating = true;
  c.lastGate = Date.now();
  stats.gated++;
  try {
    const meta = await getCoin(c.mint).catch(() => null);
    c.name = c.name || meta?.name || null;
    c.symbol = c.symbol || meta?.symbol || null;
    applyMcap(c, meta);
    const pda = bondingCurvePda(c.mint);
    const launch = await launchTxnStats(rpc, pda, 20).catch(() => null);
    if (launch) {
      c.launchTxns = launch.count;
      if (!launch.capped && launch.count < THRESHOLDS.MIN_LAUNCH_TXNS) {
        c.bundled = true; c.bundleReason = 'few-launch-txns';
      }
    }
    const holders = await mineHolders(rpc, c.mint, meta?.creator).catch(() => ({}));
    c.holderTop1 = holders.holderTop1 ?? null;
    c.holderTop10 = holders.holderTop10 ?? null;
    c.creatorPct = holders.creatorPct ?? null;
    const hv = holderVerdict({ creatorPct: c.creatorPct, holderTop1: c.holderTop1 });
    if (hv) { c.rugFake = true; c.rugReason = hv; }
  } catch { /* leave flags as-is */ }
  finally {
    c.gating = false;
    c.checked = c.holderTop1 != null;
  }
  flush();
}

function flush() {
  const now = Date.now();
  for (const [mint, c] of board) {
    const age = now - c.launchedAt;
    // drop: bonded (handed off), aged out, or never gained traction
    const drop = c.bonded || age > N.trackMs || (age > N.pruneMs && c.trades < N.minTradesToGate && !c.checked);
    if (drop) { board.delete(mint); portal.unwatchTrades(mint); }
  }
  // surface coins with signs of life (a trade, a gate verdict, or fully checked)
  const rows = [...board.values()]
    .filter((c) => c.trades > 0 || c.checked || hideReason(c) != null)
    .map((c) => {
      const hr = hideReason(c);
      return {
        mint: c.mint, name: c.name, symbol: c.symbol,
        bondedAt: c.launchedAt, ageMs: now - c.launchedAt,
        trades: c.trades, volumeSol: c.volumeSol,
        athMcapSol: c.athLevel, lastMcapSol: c.lastLevel,
        marketCapSol: c.lastLevel, marketCapUsd: c.marketCapUsd ?? null,
        dipPct: c.dipPct, maxDipPct: c.maxDipPct,
        launchTxns: c.launchTxns,
        checked: c.checked, bundled: c.bundled, rugFake: c.rugFake, rugReason: c.rugReason,
        earlyDumped: c.earlyDumped,
        holderTop1: c.holderTop1, holderTop10: c.holderTop10, creatorPct: c.creatorPct,
        hidden: hr != null, hideReason: hr,
      };
    });
  const blocked = rows.filter((r) => r.hidden).length;
  const sorted = rows.sort((a, b) => b.bondedAt - a.bondedAt);
  const meta = {
    updatedAt: now, ws: wsState, api: load(), thresholds: THRESHOLDS,
    stats: { ...stats, tracking: board.size, blocked, surfaced: rows.length - blocked },
  };
  writeSnapshot('new.json', { ...meta, coins: sorted });
  persist('new', sorted, meta);
}

const portal = new PumpPortal({
  url: config.wsUrl,
  newToken: true,
  onState: (s) => { wsState = s; },
  onMessage: (m) => {
    stats.messages++;
    const mint = m.mint;
    if (!mint) return;

    // A fresh launch. Track it (cheap) + watch its trade tape, subject to the
    // entry floor and the watch cap. Gating (RPC) waits for traction.
    if (m.txType === 'create' && !board.has(mint)) {
      stats.launchesSeen++;
      const initMcap = m.marketCapSol ?? 0;
      if (initMcap < N.minMcapSolToWatch) return;
      if (board.size >= N.maxWatch) return; // at cap; the prune in flush() frees slots
      const c = {
        mint, name: m.name ?? null, symbol: m.symbol ?? null,
        launchedAt: Date.now(), lastTradeAt: Date.now(), trades: 0, volumeSol: 0,
        firstLevel: m.marketCapSol ?? null, athLevel: m.marketCapSol ?? null, lastLevel: m.marketCapSol ?? null,
        marketCapUsd: null, dipPct: 0, maxDipPct: 0,
        launchTxns: null, bundled: false, rugFake: false, rugReason: null,
        holderTop1: null, holderTop10: null, creatorPct: null,
        checked: false, gating: false, lastGate: 0, mcapAt: 0,
        earlyClosed: false, earlyNet: (m.txType === 'create' ? (m.solAmount || 0) : 0),
        earlyEndLevel: m.marketCapSol ?? null, earlyDumped: false, bonded: false,
      };
      board.set(mint, c);
      portal.watchTrades(mint);
      return;
    }

    if (m.txType === 'buy' || m.txType === 'sell') {
      const c = board.get(mint);
      if (c) onTrade(c, m);
    }
  },
});

// Rehydrate from the last snapshot so a restart/redeploy keeps tracking.
function hydrate(row, now) {
  return {
    mint: row.mint, name: row.name ?? null, symbol: row.symbol ?? null,
    launchedAt: row.bondedAt ?? now, lastTradeAt: now,
    trades: row.trades ?? 0, volumeSol: row.volumeSol ?? 0,
    firstLevel: null, athLevel: row.athMcapSol ?? null, lastLevel: row.lastMcapSol ?? null,
    marketCapUsd: row.marketCapUsd ?? null,
    dipPct: row.dipPct ?? 0, maxDipPct: row.maxDipPct ?? 0,
    launchTxns: row.launchTxns ?? null,
    bundled: !!row.bundled, rugFake: !!row.rugFake, rugReason: row.rugReason ?? null,
    earlyDumped: !!row.earlyDumped,
    holderTop1: row.holderTop1 ?? null, holderTop10: row.holderTop10 ?? null, creatorPct: row.creatorPct ?? null,
    checked: !!row.checked, gating: false, lastGate: 0, mcapAt: 0,
    earlyClosed: true, earlyNet: 0, earlyEndLevel: null, bonded: false,
  };
}
try {
  const now = Date.now();
  let n = 0;
  for (const row of getCoins('new', N.trackMs)) {
    if (!row?.mint || board.has(row.mint) || now - (row.bondedAt ?? 0) > N.trackMs) continue;
    board.set(row.mint, hydrate(row, now));
    n++;
  }
  console.log(`[new-pairs] rehydrated ${n} coins from db`);
} catch (e) { console.log('[new-pairs] rehydrate skipped:', e?.message); }

console.log('[new-pairs] streaming new launches from', config.wsUrl);
portal.start();
for (const c of board.values()) portal.watchTrades(c.mint);
flush();
setInterval(flush, 4000);

// Gate coins once they show traction (immediate, per the study config) -- this
// is where RPC is spent, so it only runs for coins with real activity.
setInterval(() => {
  const now = Date.now();
  for (const c of board.values()) {
    if (!c.checked && !c.gating && c.trades >= N.minTradesToGate && now - (c.lastGate || 0) > 15000) gateCoin(c);
  }
}, 5000);

// Keep mcap current + detect bonding for surfaced coins.
setInterval(() => {
  const now = Date.now();
  for (const c of board.values()) {
    if (c.checked && !c.gating && hideReason(c) == null && now - (c.mcapAt || 0) > 30000) refreshMcap(c);
  }
}, 10000);
