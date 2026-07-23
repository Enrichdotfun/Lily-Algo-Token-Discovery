# Deploying Lily

Lily has two deployable parts:

- **Backend** — the API server plus the four discovery daemons: Old-prebond,
  New-pairs, Bonded and the Watchdog (one always-on Node process group via
  `npm start`). This is the only thing that talks to your RPC + PumpPortal, and it
  owns the SQLite database.
- **Frontend** — the static Vite/React UI (`npm run build` → `dist/`).

> The on-chain work is done **once** by the backend. Serving the feeds to many
> readers does **not** multiply RPC cost — consumers just read precomputed data.
> (`/api/token-meta` is the exception; it resolves uncached mints on demand.)

---

## Persistence

The backend writes to **SQLite** (`DB_PATH`, default `data/lily.db`): a durable
current board + ~48h of rolling history. To keep data across restarts/redeploys
on a host, put the DB on a **persistent disk/volume** and point `DB_PATH` at it.
Without a volume the DB is ephemeral — the board simply rebuilds from live
discovery on restart (you only lose history).

---

## Option A — Render (blueprint included)

1. Push this repo to GitHub.
2. Render → **New → Blueprint**, pick the repo. It reads `render.yaml` and creates
   `lily-api` (backend, with a 1 GB disk at `/data`). The UI is deployed on Vercel
   (see "Serving it at `enrich.fun/lily`" below).
3. In **lily-api → Environment**, set `SOLANA_RPC_URL` (a dedicated provider —
   Helius/Triton/etc.). Optionally set `LILY_API_KEYS` to gate the public API.
4. Deploy. Health check is `/api/health`.

*Free-tier note:* disks need a paid instance. To stay free, delete the `disk:`
block in `render.yaml` and drop `DB_PATH` (SQLite goes ephemeral — fine, just no
history across restarts).

---

## Option B — Railway

1. Push to GitHub → Railway **New Project → Deploy from repo**.
2. **Backend service:** start command `npm start`. Add a **Volume** mounted at
   `/data` and set `DB_PATH=/data/lily.db`. Set `SOLANA_RPC_URL` (and optionally
   `LILY_API_KEYS`). Railway sets `PORT` automatically.
3. **Frontend:** either add a second service that builds the UI
   (`npm run build`) and serves `dist/`, or host `dist/` on Cloudflare Pages /
   Vercel / Netlify. Set `VITE_API_URL` to the backend's public URL at build time.

---

## Serving it at `enrich.fun/lily` (Vercel + Render)

The UI is a static bundle (Vercel); the API + discovery daemons are a separate
origin (Render). The UI calls the API directly — the API sends permissive CORS,
so no same-domain proxy is required.

The build **nests its output under the base path**: with `VITE_BASE=/lily/`, Vite
emits to `dist/lily/` and references assets as `/lily/assets/...`, so the deploy
works behind the `/lily` subpath with no rewrite hacks.

### 1. Backend on Render
Deploy the blueprint (above) → set `SOLANA_RPC_URL` → note the public URL, e.g.
`https://<your-backend>.onrender.com`.

### 2. Frontend as its own Vercel project
Import the repo as a **new Vercel project** and set two **Environment Variables**
(Production), then deploy:

```
VITE_BASE     = /lily/
VITE_API_URL  = https://<your-backend>.onrender.com
```

`vercel.json` pins the build/output and redirects the project root to `/lily/`,
so the standalone deployment serves at `https://<lily-project>.vercel.app/lily/`.

### 3. Route `enrich.fun/lily` → the Lily project
In your **existing enrich.fun Vercel project**, add a cross-project rewrite to
`vercel.json` (paths line up because the build is based at `/lily/`):

```json
{
  "rewrites": [
    { "source": "/lily", "destination": "https://<lily-project>.vercel.app/lily" },
    { "source": "/lily/:path*", "destination": "https://<lily-project>.vercel.app/lily/:path*" }
  ]
}
```

Redeploy enrich.fun. `enrich.fun/lily` now serves Lily; its API calls go straight
to Render.

> Prefer a subdomain? Point `lily.enrich.fun` (CNAME) at the Lily Vercel project,
> drop `VITE_BASE` (build at root), and skip the rewrite.

### Single-domain alternative (nginx / Cloudflare)
Point `enrich.fun/lily/*` at the static build and `enrich.fun/api/*` at the
backend; build with `VITE_BASE=/lily/` and `VITE_API_URL=""` (same-origin `/api`).

---

## HTTP API

Nothing is hosted for you — this is the API *your* deployment exposes. Consumers
can then poll (add `?key=...` or an `x-api-key` header if `LILY_API_KEYS` is set):

```
GET /api/old          # reawakened old pre-bond coins
GET /api/new          # gated fresh launches
GET /api/bonded       # gated graduates
GET /api/token-meta   # ?mints=<comma-separated> — name / symbol / image
GET /api/watchdog     # last re-verification pass (quarantine, revivals)
GET /api/health       # liveness; open by design so health checks need no key
```

- Responses are JSON, CORS-open, cached ~2s, and rate-limited
  (`RATE_LIMIT_PER_MIN`, per key or per IP).
- Set `LILY_API_KEYS` (comma-separated) to require a key; hand each consumer one.
  Every route except `/api/health` is then gated.
- Feed cost stays flat as readers grow — they read cached output, not the chain.
  `/api/token-meta` is the exception: uncached mints are resolved against the
  pump.fun API on demand (capped at 25 per request).
