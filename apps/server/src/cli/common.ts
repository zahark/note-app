// Shared plumbing of the operator CLIs (`reset-password`, `backup`, `backup:offsite`, `restore:offsite`).
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ConfigError,
  DEFAULT_DATA_DIR,
  OFFSITE_BACKUP_REQUIRED,
  parseOffsiteBackupConfig,
  type OffsiteBackupConfig,
} from '../config.js'

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

/** What the off-site CLIs read from outside; the defaults are what an operator gets. */
export interface OffsiteCliOptions {
  /** Where DATA_DIR and the BACKUP_* settings come from (default `process.env`). */
  env?: NodeJS.ProcessEnv
  /**
   * Tests only: send every S3 request to this endpoint (a local http fake server) instead of the
   * configured one, which config accepts only as https.
   */
  endpoint?: URL
}

/**
 * The off-site backup settings from the BACKUP_* variables alone (the server's secrets are not needed).
 * Bad or missing settings are a `CliError`.
 */
export function cliOffsiteConfig({ env = process.env, endpoint }: OffsiteCliOptions = {}): OffsiteBackupConfig {
  let cfg: OffsiteBackupConfig | null
  try {
    cfg = parseOffsiteBackupConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) throw new CliError(err.message)
    throw err
  }
  if (cfg === null) {
    throw new CliError(`Off-site backups are not configured: set ${OFFSITE_BACKUP_REQUIRED.join(', ')}`)
  }
  return endpoint === undefined ? cfg : { ...cfg, endpoint }
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
