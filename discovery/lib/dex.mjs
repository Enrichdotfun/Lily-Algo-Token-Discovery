// Live mcap/price for BONDED coins, via DexScreener.
//
// Why not pump.fun's frontend-api here? Two reasons:
//   1. Its market_cap reflects the BONDING CURVE, frozen at graduation — a coin
//      that pumps 4x on the AMM still reads its bond-time value.
//   2. Cloudflare blocks datacenter IPs, so getCoin() fails from Railway/Render
//      (-> null -> the mcap never updates and stays stuck on the board).
//
// DexScreener reads the live AMM pool (pumpswap/raydium) and is datacenter-friendly,
// so it's the correct post-bond source for both freshness and reliability.
import { tick } from './metrics.mjs';

const BASE = 'https://api.dexscreener.com/latest/dex/tokens/';
const HEADERS = { accept: 'application/json' };

/**
 * Live market cap (USD) for a mint, from the deepest-liquidity pair.
 * Returns { marketCapUsd, priceUsd } or null when the token isn't indexed yet
 * (a freshly-bonded pool can take a few seconds to appear).
 */
export async function getDexMcap(mint) {
  tick();
  const res = await fetch(BASE + mint, { headers: HEADERS });
  if (!res.ok) return null;
  const j = await res.json();
  const pairs = (j?.pairs || []).filter((p) => p && (p.marketCap != null || p.fdv != null));
  if (!pairs.length) return null;
  // Deepest pool = the real live market; this drops the dust/curve pairs that
  // otherwise report a stale, much-lower mcap.
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];
  const mc = p.marketCap ?? p.fdv ?? null;
  if (mc == null) return null;
  return { marketCapUsd: mc, priceUsd: p.priceUsd ? Number(p.priceUsd) : null };
}
