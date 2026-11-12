import { rmSync } from 'node:fs'

/** Removes the throwaway DATA_DIR that `playwright.config.ts` created for the server. */
export default function globalTeardown(): void {
  const dir = process.env.NOTES_E2E_DATA_DIR
  if (dir) rmSync(dir, { recursive: true, force: true })
}
