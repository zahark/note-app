import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/** The `pdfjs-dist` data directories PDF.js fetches on demand (see `src/features/editor/pdf.ts`). */
const PDFJS_ASSET_DIRS = ['standard_fonts', 'cmaps'] as const

/**
 * Serves PDF.js's standard-font data and CMaps same-origin under `/pdfjs/<dir>/<file>`: copied into the
 * build output (so the server's static route serves them) and answered from `node_modules` in dev.
 * Only the flat files listed in those directories are served.
 */
function pdfjsAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const files = PDFJS_ASSET_DIRS.flatMap((dir) =>
    readdirSync(path.join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ url: `pdfjs/${dir}/${entry.name}`, file: path.join(root, dir, entry.name) })),
  )
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      const byUrl = new Map(files.map(({ url, file }) => [`/${url}`, file]))
      server.middlewares.use((req, res, next) => {
        const file = byUrl.get((req.url ?? '').split('?', 1)[0]!)
        if (!file) return next()
        res.setHeader('content-type', 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const { url, file } of files) this.emitFile({ type: 'asset', fileName: url, source: readFileSync(file) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // Single origin in dev too: the SPA proxies API calls to the Fastify server.
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
