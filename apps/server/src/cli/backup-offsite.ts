// `npm run backup:offsite`: uploads one off-site backup now (the same run the server's daily job makes).
// Reads only DATA_DIR and the BACKUP_* settings, so it works without the server's secrets. It neither
// records the run in `offsite-backup.json` (the daily schedule stays as it is) nor prunes old backups.
import { DB_FILE_NAME } from '../db/index.js'
import { UPLOADS_ARCHIVE_NAME } from '../services/backup.js'
import { runOffsiteBackup, type OffsiteBackupResult } from '../services/offsiteBackup.js'
import {
  CliError,
  cliDataDir,
  cliOffsiteConfig,
  refuseRoot,
  runIfInvokedDirectly,
  toCliError,
  type OffsiteCliOptions,
} from './common.js'

export interface BackupOffsiteOptions extends OffsiteCliOptions {
  /** Snapshot time (tests; default now). */
  now?: Date
}

/**
 * The CLI (exported for tests): expected failures (config, no database, S3 or connection errors) are
 * `CliError`s.
 */
export async function main(args: string[], options: BackupOffsiteOptions = {}): Promise<void> {
  // as root, opening the live database could leave root-owned notes.db-wal/-shm the server cannot open
  refuseRoot('backup:offsite')
  if (args.length > 0) throw new CliError('Usage: npm run backup:offsite')
  const cfg = cliOffsiteConfig(options)
  const dataDir = cliDataDir(options.env)
  let result: OffsiteBackupResult
  try {
    result = await runOffsiteBackup(dataDir, cfg, { now: options.now })
  } catch (err) {
    throw toCliError(err, 'Off-site backup failed')
  }
  console.log(
    `Off-site backup ${result.name} uploaded to ${cfg.bucket}/${cfg.prefix}${result.name}/ ` +
      `(${DB_FILE_NAME} ${result.files[DB_FILE_NAME].size} bytes, ` +
      `${UPLOADS_ARCHIVE_NAME} ${result.files[UPLOADS_ARCHIVE_NAME].size} bytes)`,
  )
}

runIfInvokedDirectly(import.meta.url, (args) => main(args))
