// Shared plumbing of the operator CLIs (`reset-password`, `backup`).
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_DATA_DIR } from '../config.js'

/** DATA_DIR as the server resolves it (the CLIs read only this variable, never `.env`). */
export function cliDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DATA_DIR?.trim() || DEFAULT_DATA_DIR)
}

/** An expected operator error (bad arguments, missing database, ...), reported without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

/**
 * Runs `main` with the command-line arguments when the module at `moduleUrl` is the script node was
 * started with (not when a test imports it). A `CliError` is printed as a plain message, anything else
 * with its stack; both exit with status 1.
 */
export function runIfInvokedDirectly(moduleUrl: string, main: (args: string[]) => Promise<void>): void {
  const script = process.argv[1]
  if (!script) return
  let invoked: boolean
  try {
    invoked = moduleUrl === pathToFileURL(realpathSync(script)).href
  } catch {
    invoked = false
  }
  if (!invoked) return
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof CliError ? err.message : err)
    process.exit(1)
  })
}
