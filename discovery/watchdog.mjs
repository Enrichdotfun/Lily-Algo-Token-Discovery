// ---------------------------------------------------------------------------
// WATCHDOG — 24/7 independent safety verifier
//
// Re-checks EVERY coin currently surfaced as TRADABLE (new + bonded), one by one,
// to make sure nothing unsafe has leaked through -- or turned bad AFTER being
// cleared (e.g. the creator dumps, a whale accumulates, the coin craters). For
// each tradable coin it independently re-fetches mcap and re-mines holders, then
// re-applies the gates. Anything that now trips a gate is QUARANTINED.
//
// The API server reads the quarantine list and force-hides those coins, so a
// leak is pulled out of Tradable within seconds. State is written to
// data/watchdog.json and exposed at GET /api/watchdog.
// ---------------------------------------------------------------------------
import { config } from './lib/config.mjs';
import { makeRpc, mineHolders } from './lib/rpc.mjs';
import { bundleVerdict, holderVerdict, isCratered, THRESHOLDS } from './lib/gates.mjs';
import { getCoin } from './lib/pumpfun.mjs';
import { getDexMcap } from './lib/dex.mjs';
import { writeSnapshot } from './lib/store.mjs';
import { getCoins } from './lib/db.mjs';

const W = config.watchdog;
const rpc = makeRpc(config.rpcUrl);

// Live mcap (USD) for a coin under check. Bonded coins trade on the AMM, where the
// truth is DexScreener (pump.fun reports the frozen curve value and is blocked from
// datacenter IPs); pre-bond ("new") coins are still on the curve, where pump.fun
// (or the last snapshot) is correct. Falls back to the snapshot in both cases.
async function liveMcUsd(c, feed, meta) {
  if (feed === 'bonded') {
    const dex = await getDexMcap(c.mint).catch(() => null);
    if (dex?.marketCapUsd != null) return dex.marketCapUsd;
  }
  return meta?.marketCapUsd ?? c.marketCapUsd ?? null;
}
const lastChecked = new Map();    // mint -> ts of last verification
const quarantine = new Map();     // mint -> { reason, at, feed, ... }
const revivals = new Map();       // mint -> { at, feed, mcUsd, top1, ... } bundle-sold + near-launch
const revivalChecked = new Map(); // mint -> ts of last revival scan
let verified = 0;

function feedCoins(feed) {
  const trackMs = (feed === 'new' ? config.newPairs : config.bonded).trackMs;
  return getCoins(feed, trackMs) || [];
}

/** Coins the UI shows as Tradable for a feed. */
function tradableOf(feed) {
  return feedCoins(feed).filter((c) => {
    if (!c.checked || c.hidden) return false;
    if (feed === 'new' && (c.marketCapUsd ?? 0) < W.tradableMinMcUsd) return false;
    return true;
  });
}

/**
 * Audit Blocked coins for FALSE blocks (good coins wrongly hidden). Cheap pass:
 * re-checks the recorded block reason against the stored signals (no RPC) — e.g.
 * a coin blocked as "bundle" whose maxPerSlot is actually below the threshold.
 */
function auditBlocked() {
  const out = [];
  for (const feed of ['new', 'bonded']) {
    for (const c of feedCoins(feed)) {
      if (!c.hidden) continue;
      // A true false-block: hidden, but NONE of the gates actually hold per the
      // stored signals. Checking every gate (not just bundle) makes it safe to
      // auto-clear — we never un-hide a coin that's genuinely a rug/crater/etc.
      const real =
        bundleVerdict({ maxPerSlot: c.maxPerSlot, lifetimeTxns: c.launchTxns, holderTop1: c.holderTop1 }) ||
        holderVerdict({ creatorPct: c.creatorPct, holderTop1: c.holderTop1 }) ||
        (isCratered(c.dipPct) ? 'crater' : null) ||
        (c.earlyDumped ? 'early-dump' : null);
      if (!real) {
        out.push({
          mint: c.mint, feed, symbol: c.symbol ?? null, was: c.hideReason ?? null,
          note: `maxPerSlot=${c.maxPerSlot} top1=${c.holderTop1} dev=${c.creatorPct} dip=${c.dipPct}`,
        });
      }
    }
  }
  return out;
}

/** Independently re-verify one tradable coin. Returns a leak reason or null. */
async function verify(c, feed) {
  lastChecked.set(c.mint, Date.now());
  verified++;
  const meta = await getCoin(c.mint).catch(() => null);
  const mcUsd = await liveMcUsd(c, feed, meta);
  const holders = await mineHolders(rpc, c.mint, meta?.creator).catch(() => ({}));
  const top1 = holders.holderTop1 ?? c.holderTop1 ?? null;
  const creatorPct = holders.creatorPct ?? c.creatorPct ?? null;

  let reason = holderVerdict({ creatorPct, holderTop1: top1 });           // turned into a rug
  if (!reason && isCratered(c.dipPct)) reason = 'crater';                  // died after clearing
  if (!reason && feed === 'new' && mcUsd != null && mcUsd < W.tradableMinMcUsd) reason = 'under-min-mcap';

  if (reason) {
    if (!quarantine.has(c.mint)) {
      console.log(`[watchdog] LEAK ${feed} ${c.symbol || c.mint.slice(0, 8)} -> ${reason} (top1=${top1} dev=${creatorPct} mc=${mcUsd})`);
    }
    quarantine.set(c.mint, { reason, at: Date.now(), feed, symbol: c.symbol ?? null, top1, creatorPct, mcUsd });
  } else {
    quarantine.delete(c.mint); // re-verified clean
  }
  return reason;
}

/** Coins that were a BUNDLED launch (slot-clustered) — revival candidates. */
function bundledCandidates() {
  const out = [];
  for (const feed of ['new', 'bonded']) {
    for (const c of feedCoins(feed)) {
      if (typeof c.maxPerSlot === 'number' && c.maxPerSlot >= THRESHOLDS.BUNDLE_MAX_PER_SLOT) out.push([c, feed]);
    }
  }
  return out;
}

/**
 * Scan one bundled coin for the "second revival": its bundle has SOLD (holders are
 * clean again) AND it's fallen back to near launch mcap. If so it's no longer a
 * bundle risk — the server un-blocks it and re-baselines (dip reset) so we evaluate
 * it from this reset point, not the original bundled pump.
 */
async function scanRevival(c, feed) {
  revivalChecked.set(c.mint, Date.now());
  const meta = await getCoin(c.mint).catch(() => null);
  const mcUsd = await liveMcUsd(c, feed, meta);
  const holders = await mineHolders(rpc, c.mint, meta?.creator).catch(() => ({}));
  const top1 = holders.holderTop1 ?? null;
  const creatorPct = holders.creatorPct ?? null;
  const bundleSold = top1 != null && holderVerdict({ creatorPct, holderTop1: top1 }) == null;
  const nearLaunch = mcUsd != null && mcUsd <= W.revivalMaxMcUsd;
  if (bundleSold && nearLaunch) {
    if (!revivals.has(c.mint)) {
      console.log(`[watchdog] REVIVAL ${feed} ${c.symbol || c.mint.slice(0, 8)} — bundle sold + back near launch (top1=${top1.toFixed(1)}% mc=$${Math.round(mcUsd)})`);
    }
    revivals.set(c.mint, { at: Date.now(), feed, symbol: c.symbol ?? null, mcUsd, top1, creatorPct, baselineMcUsd: mcUsd });
  } else {
    revivals.delete(c.mint); // bundle still held, or it has run past launch again
  }
}

async function tick() {
  const now = Date.now();
  const tradable = [
    ...tradableOf('new').map((c) => [c, 'new']),
    ...tradableOf('bonded').map((c) => [c, 'bonded']),
  ];
  // Re-verify each tradable coin at most once per recheckMs; cap per tick for RPC budget.
  const due = tradable
    .filter(([c]) => now - (lastChecked.get(c.mint) || 0) > W.recheckMs)
    .slice(0, W.perTick);
  for (const [c, feed] of due) { try { await verify(c, feed); } catch { /* keep going */ } }

  // Forget quarantine + lastChecked for coins no longer surfaced.
  const live = new Set(tradable.map(([c]) => c.mint));
  for (const m of [...quarantine.keys()]) if (!live.has(m)) quarantine.delete(m);
  for (const m of [...lastChecked.keys()]) if (!live.has(m)) lastChecked.delete(m);

  const falseBlocks = auditBlocked();
  if (falseBlocks.length) console.log(`[watchdog] ${falseBlocks.length} FALSE-BLOCK(s), e.g. ${falseBlocks[0].symbol || falseBlocks[0].mint.slice(0, 8)} (${falseBlocks[0].reason}; ${falseBlocks[0].note})`);

  // Revival scan: bundled launches whose bundle has sold + back near launch mcap.
  const cands = bundledCandidates();
  const dueR = cands
    .filter(([c]) => now - (revivalChecked.get(c.mint) || 0) > W.revivalRecheckMs)
    .slice(0, W.revivalPerTick);
  for (const [c, feed] of dueR) { try { await scanRevival(c, feed); } catch { /* keep going */ } }
  const allLive = new Set([...feedCoins('new'), ...feedCoins('bonded')].map((c) => c.mint));
  for (const m of [...revivals.keys()]) if (!allLive.has(m)) revivals.delete(m);
  for (const m of [...revivalChecked.keys()]) if (!allLive.has(m)) revivalChecked.delete(m);

  writeSnapshot('watchdog.json', {
    lastRun: now,
    tradableCount: tradable.length,
    verifiedTotal: verified,
    leakCount: quarantine.size,
    leaks: [...quarantine.entries()].map(([mint, v]) => ({ mint, ...v })),
    quarantine: [...quarantine.keys()],
    falseBlockCount: falseBlocks.length,
    falseBlocks: falseBlocks.slice(0, 500),
    revivalCount: revivals.size,
    revivals: [...revivals.entries()].map(([mint, v]) => ({ mint, ...v })),
  });
}

console.log(`[watchdog] re-verifying tradable coins every ${W.tickMs / 1000}s (recheck/coin ${W.recheckMs / 1000}s)`);
tick();
setInterval(tick, W.tickMs);
