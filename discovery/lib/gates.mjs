// ---------------------------------------------------------------------------
// Quality gates for the BONDED feed. Transparent on-chain heuristics for "did
// this graduate launch fairly, or is it an obvious rug/farm?". Defaults are
// reasonable starting points, not tuned edges — verify on your own data.
//
// (The new-pairs / pre-bond gate is intentionally not part of this public repo.)
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  BUNDLE_MAX_PER_SLOT: 8,     // >= this many opening txns in a SINGLE slot => bundled/sniped launch
  BUNDLE_GRACE_TXNS: 500,     // >= this many lifetime txns => coin outlived its launch bundle (heavily traded)
  CREATOR_RETENTION_PCT: 10,  // creator still holding >= this % of supply => rug risk
  WHALE_FLOAT_PCT: 15,        // a single non-pool wallet holding >= this % => whale-float risk
  EARLY_DUMP_RET_PCT: -30,    // first-minute return <= this ...
  EARLY_DUMP_NET_SOL: -5,     // ... AND first-minute net flow <= this => early dump
  CRATER_DIP_PCT: -85,        // drawn down >= this far from ATH => dead/crater, hide it
};

/**
 * Bundle verdict from launch-slot clustering. A bundled/sniped launch buys a big
 * chunk of supply in the SAME slot as creation, so many opening txns share one
 * slot. But a launch bundle only matters while the coin is YOUNG and still
 * concentrated — so it's NOT flagged once the coin has been traded heavily
 * (lifetimeTxns >= grace) or the bundle has distributed (holderTop1 clean).
 *   - maxPerSlot   : opening-window max txns/slot (from launchTxnStats)
 *   - lifetimeTxns : total txns on the bonding curve (organic activity since launch)
 *   - holderTop1   : current largest non-pool holder % (bundle still held?)
 */
export function bundleVerdict({ maxPerSlot, lifetimeTxns, holderTop1 }) {
  if (typeof maxPerSlot !== 'number' || maxPerSlot < THRESHOLDS.BUNDLE_MAX_PER_SLOT) return null; // not slot-clustered
  if (typeof lifetimeTxns === 'number' && lifetimeTxns >= THRESHOLDS.BUNDLE_GRACE_TXNS) return null; // outlived the bundle
  if (typeof holderTop1 === 'number' && holderTop1 < THRESHOLDS.WHALE_FLOAT_PCT) return null; // bundle distributed/sold
  return 'bundle';
}

/** Holder verdict from on-chain holders. Returns a reason or null. */
export function holderVerdict({ creatorPct, holderTop1 }) {
  const T = THRESHOLDS;
  if (typeof creatorPct === 'number' && creatorPct >= T.CREATOR_RETENTION_PCT) return 'creator-retention';
  if (typeof holderTop1 === 'number' && holderTop1 >= T.WHALE_FLOAT_PCT) return 'whale-float';
  return null;
}

/** First-minute strength check for a freshly bonded coin. */
export function earlyDumpVerdict({ earlyReturnPct, earlyNetSol }) {
  const T = THRESHOLDS;
  if (
    typeof earlyReturnPct === 'number' && earlyReturnPct <= T.EARLY_DUMP_RET_PCT &&
    typeof earlyNetSol === 'number' && earlyNetSol <= T.EARLY_DUMP_NET_SOL
  ) return 'early-dump';
  return null;
}

export function isCratered(dipPct) {
  return typeof dipPct === 'number' && dipPct <= THRESHOLDS.CRATER_DIP_PCT;
}
