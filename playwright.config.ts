import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * E2E against the production build, started directly with Node (no Docker): the web app and the
 * server are built, then the compiled server serves the SPA and the API on one origin, with test
 * secrets and a throwaway DATA_DIR (removed by `e2e/global-teardown.ts`).
 */
const port = Number(process.env.E2E_PORT ?? 3100)
const origin = `http://127.0.0.1:${port}`

// this file is also loaded by every worker; they inherit the main process's env, so the directory is made once
process.env.NOTES_E2E_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), 'notes-e2e-'))

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
  // one smoke path that builds on its own state, against one server
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && node apps/server/dist/index.js',
    url: `${origin}/api/health`,
    // a fresh server every run: the data directory and the in-memory rate limits start empty
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
      SHARE_HMAC_KEY: 'e2e-share-hmac-key-0123456789abcdef0123456789',
      PUBLIC_ORIGIN: origin,
      // ALLOW_SIGNUP unset: the default first-user-only signup creates the owner on the empty DATA_DIR
      DATA_DIR: process.env.NOTES_E2E_DATA_DIR,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'warn',
    },
  },
})
