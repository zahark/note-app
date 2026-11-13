// `npm run backup:offsite`: uploads one off-site backup now (the same run the server's daily job makes).
// Reads only DATA_DIR and the BACKUP_* settings, so it works without the server's secrets. It neither
// records the run in `offsite-backup.json` (the daily schedule stays as it is) nor prunes old backups.
import { DB_FILE_NAME } from '../db/index.js'
import { BackupError, UPLOADS_ARCHIVE_NAME } from '../services/backup.js'
import { runOffsiteBackup } from '../services/offsiteBackup.js'
import { S3Error } from '../services/s3.js'
import { CliError, cliDataDir, cliOffsiteConfig, runIfInvokedDirectly, type OffsiteCliOptions } from './common.js'

export interface BackupOffsiteOptions extends OffsiteCliOptions {
  /** Snapshot time (tests; default now). */
  now?: Date
}

/** The CLI (exported for tests): expected failures (config, no database, S3 errors) are `CliError`s. */
export async function main(args: string[], options: BackupOffsiteOptions = {}): Promise<void> {
  if (args.length > 0) throw new CliError('Usage: npm run backup:offsite')
  const cfg = cliOffsiteConfig(options)
  const dataDir = cliDataDir(options.env)
  let result
  try {
    result = await runOffsiteBackup(dataDir, cfg, { now: options.now })
  } catch (err) {
    if (err instanceof BackupError) throw new CliError(err.message)
    if (err instanceof S3Error) throw new CliError(`Off-site backup upload failed: ${err.message}`)
    throw err
  }
  console.log(
    `Off-site backup ${result.name} uploaded to ${cfg.bucket}/${cfg.prefix}${result.name}/ ` +
      `(${DB_FILE_NAME} ${result.files['notes.db'].size} bytes, ` +
      `${UPLOADS_ARCHIVE_NAME} ${result.files['uploads.tar.gz'].size} bytes)`,
  )
}

runIfInvokedDirectly(import.meta.url, (args) => main(args))
