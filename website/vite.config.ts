import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';

/* The app version lives in the parent package.json (the desktop app's single
   source of truth). Read it here so the embedded <ReconApp /> reports the real
   version instead of falling back to 0.0.0 in the browser. */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as { version?: string };

/* Trailing-slash URLs (/tracker/) only return 200 from a directory index —
   neither GitHub Pages nor a plain static server maps them to a sibling
   tracker.html. Duplicate each flat entry after bundling so /tracker and
   /tracker/ serve byte-identical HTML with a 200. */
function cleanUrlsPlugin(): Plugin {
  return {
    name: 'recon-clean-urls',
    writeBundle(options) {
      const dir = options.dir ?? 'dist';
      for (const name of ['tracker', 'stretch', 'download']) {
        mkdirSync(path.join(dir, name), { recursive: true });
        copyFileSync(path.join(dir, `${name}.html`), path.join(dir, name, 'index.html'));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), cleanUrlsPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  },
  /* Port 5173 belongs to the DESKTOP app: src-tauri/tauri.conf.json points
     devUrl at http://localhost:5173 and the app's vite runs with strictPort.
     Squatting on it makes `tauri dev` fail to bind and then load the website
     instead of the app. Keep the site on its own port. */
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      /* One real HTML file per URL — no router, no SPA fallback. index.html
         keeps mounting src/main.tsx (home); each sub-page mounts its own
         small entry under src/entries/, which renders a page that already
         includes its own <SiteChrome>. */
      input: {
        main: path.resolve(__dirname, 'index.html'),
        tracker: path.resolve(__dirname, 'tracker.html'),
        stretch: path.resolve(__dirname, 'stretch.html'),
        download: path.resolve(__dirname, 'download.html'),
      },
    },
  },
});
