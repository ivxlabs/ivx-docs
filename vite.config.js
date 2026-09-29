// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Serves PDF.js's runtime data under pdfjs/ — character maps for CJK text,
 * the standard fonts, the WebAssembly image decoders and colour profiles.
 * Files it fetches at run time, so they are copied rather than bundled.
 */
function pdfjsAssets() {
  const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
  const DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

  return {
    name: 'ivx:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const file = join(root, rel);
        if (!DIRS.includes(rel.split('/')[0]) || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const dir of DIRS) {
        for (const name of readdirSync(join(root, dir))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
        }
      }
    },
  };
}

/**
 * Stamps the built asset list into sw.js, the way ivx/ai Chat does it: a
 * precache manifest is a list of strings, not a reason for a runtime library.
 * PDF.js's data files stay out of it — most documents never need them, and
 * the worker caches each one the first time it is fetched.
 */
function serviceWorkerPrecache() {
  let outDir = 'dist';

  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

  return {
    name: 'ivx:sw-precache',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    async closeBundle() {
      const files = walk(outDir)
        .map(f => relative(outDir, f).split(sep).join(posix.sep))
        .filter(f => f !== 'sw.js' && !f.startsWith('pdfjs/') && !f.endsWith('.woff') && !f.endsWith('.map'))
        .sort();

      const digest = createHash('sha256');
      for (const f of files) digest.update(f).update(await readFile(join(outDir, f)));

      const sw = join(outDir, 'sw.js');
      await writeFile(sw, (await readFile(sw, 'utf8'))
        .replace('__CACHE_VERSION__', digest.digest('hex').slice(0, 12))
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(files.map(f => `./${f}`), null, 2)));
    },
  };
}

export default defineConfig({
  base: './',                                          // drop the build in any directory of any host
  plugins: [pdfjsAssets(), serviceWorkerPrecache()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,                              // keep fonts and icons as real, cacheable files
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2048,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
