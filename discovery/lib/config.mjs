// Centralised, env-driven configuration. Everything here is a tunable heuristic
// with a documented default — nothing secret. Override via a local `.env`.
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal, dependency-free .env loader: reads <repo>/.env if present and fills in
// any vars not already set in the environment. (No-op when the file is absent.)
(function loadDotEnv() {
  try {
    const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* no .env — use defaults / real env */ }
})();

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  rpcUrl: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  wsUrl: str('PUMPPORTAL_WS_URL', 'wss://pumpportal.fun/api/data'),
  port: num('PORT', 8787),

  // Persistence (SQLite) — durable current state + rolling history.
  dbPath: str('DB_PATH', 'data/lily.db'),
  historyIntervalMs: num('HISTORY_INTERVAL_MS', 60_000),
  historyRetentionMs: num('HISTORY_RETENTION_MS', 48 * 60 * 60 * 1000),

  // Public API controls (all optional).
  apiKeys: str('LILY_API_KEYS', ''),         // comma-list; if empty the API is open
  rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 240),

  // Old pre-bond scanner
  old: {
    scanIntervalMs: num('OLD_SCAN_INTERVAL_MS', 60_000),
    minAgeMs: num('OLD_MIN_AGE_MS', 7 * 60 * 60 * 1000),
    activeMs: num('OLD_ACTIVE_MS', 60 * 60 * 1000),
    minRecentTrades: num('OLD_MIN_RECENT_TRADES', 5),
    maxPerScan: num('OLD_MAX_PER_SCAN', 12),
  },

  // Bonded (postbond)
  bonded: {
    trackMs: num('BONDED_TRACK_MS', 60 * 60 * 1000),
    earlyWindowMs: num('BONDED_EARLY_WINDOW_MS', 60_000),
  },

  // New pairs (pre-bond). Launches are a firehose, so cost is bounded by a watch
  // cap + a traction gate (only spend RPC on coins that actually get traded).
  newPairs: {
    trackMs: num('NEWPAIRS_TRACK_MS', 30 * 60 * 1000),
    earlyWindowMs: num('NEWPAIRS_EARLY_WINDOW_MS', 60_000),
    minMcapSolToWatch: num('NEWPAIRS_MIN_MCAP_SOL', 0), // entry floor from the create event (0 = watch all, capped)
    minTradesToGate: num('NEWPAIRS_MIN_TRADES', 6),     // traction before spending RPC gating it
    maxWatch: num('NEWPAIRS_MAX_WATCH', 300),           // cap concurrent trade subscriptions
    pruneMs: num('NEWPAIRS_PRUNE_MS', 5 * 60 * 1000),   // drop no-traction coins after this
  },
};

// pump.fun public program + AMM/pool program ids (publicly known constants).
export const PROGRAMS = {
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMP_SWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
};

// Owners that are pools, not real holders — excluded from concentration math.
export const POOL_OWNERS = new Set([
  PROGRAMS.PUMP_FUN,
  PROGRAMS.PUMP_SWAP,
  PROGRAMS.RAYDIUM_V4,
  PROGRAMS.RAYDIUM_CLMM,
]);
