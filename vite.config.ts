import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The UI talks to the API server via /api (proxied in dev).
//   VITE_BASE     — public base path (set to "/lily/" when hosting at enrich.fun/lily)
//   VITE_API_URL  — absolute API origin in production (e.g. https://<your-backend>.onrender.com)
//   PORT          — local API port for the dev proxy
const apiPort = process.env.PORT || '8787';

// When hosting under a subpath (VITE_BASE=/lily/), nest the build output to match,
// so a file referenced as /lily/assets/x.js actually lives at dist/lily/assets/x.js.
// This makes the static deploy work as-is behind enrich.fun/lily with no rewrites.
const base = process.env.VITE_BASE || '/';
const outDir = base === '/' ? 'dist' : `dist${base.replace(/\/+$/, '')}`;

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  build: { outDir, emptyOutDir: true },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
});
