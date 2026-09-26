import { defineConfig } from 'vite';
import path from 'node:path';

const backend = 'http://localhost:8005';

export default defineConfig({
  root: 'web',
  base: './', // asset URLs resolve against the <base href> the server writes
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0, // the CSP allows no data: fonts, media or fetches
    modulePreload: { polyfill: false }, // no inline script under the CSP
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'web/index.html'),
        player: path.resolve(import.meta.dirname, 'web/player.html'),
        login: path.resolve(import.meta.dirname, 'web/login.html')
      }
    }
  },
  // Dev (npm run dev:web next to npm run dev): Vite serves the pages, the Express server everything else.
  server: {
    proxy: Object.fromEntries(['/api', '/thumbnails', '/previews', '^/login$', '/s/'].map((prefix) => [prefix, backend]))
  },
  plugins: [{
    name: 'watch-page',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (/^\/watch\/\d+\/?(\?|$)/.test(req.url)) req.url = '/player.html';
        next();
      });
    }
  }]
});
