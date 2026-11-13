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
import { errorMessage } from '../errors.js'
import { BackupError } from '../services/backup.js'
import { S3Error } from '../services/s3.js'

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

/** What runs a command as the app user over `fly ssh console` (which logs in as root). */
export const FLY_APP_USER_PREFIX = 'setpriv --reuid=1000 --regid=1000 --clear-groups npm --prefix /app/apps/server run'

/**
 * Refuses to run as root: files written into DATA_DIR (a staged restore, a SQLite WAL next to the live
 * database) must belong to the app user (uid 1000), or the server cannot use them. `command` is the npm
 * script with its arguments, for the hint.
 */
export function refuseRoot(command: string): void {
  if (process.getuid?.() !== 0) return
  throw new CliError(
    'Refusing to run as root: files it writes into DATA_DIR must belong to the app user (uid 1000). Run instead:\n' +
      `  ${FLY_APP_USER_PREFIX} ${command}`,
  )
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
 * An expected failure of an off-site CLI run as a `CliError` (no stack trace): a `BackupError` (no
 * database, a corrupt archive), an `S3Error` from the bucket, or a system error (a refused or reset
 * connection, a full disk), with the message `<context>: <its message>`. A `CliError` and anything else
 * (a bug) are returned unchanged.
 */
export function toCliError(err: unknown, context: string): unknown {
  if (err instanceof CliError) return err
  const systemError = typeof (err as NodeJS.ErrnoException | null)?.code === 'string'
  if (err instanceof BackupError || err instanceof S3Error || systemError) {
    return new CliError(`${context}: ${errorMessage(err)}`)
  }
  return err
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
