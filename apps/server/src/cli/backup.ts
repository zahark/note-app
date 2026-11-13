// `npm run backup -- [outDir]`: writes a consistent snapshot of DATA_DIR while the server keeps running.
// The snapshot itself (online SQLite copy + tarball of the referenced uploads) is `runBackup` in
// `services/backup.ts`; this is the operator front end. Needs only DATA_DIR.
import path from 'node:path'
import { DB_FILE_NAME } from '../db/index.js'
import { BackupError, runBackup, UPLOADS_ARCHIVE_NAME } from '../services/backup.js'
import { CliError, cliDataDir, runIfInvokedDirectly } from './common.js'

export interface BackupCliOptions {
  /** Where DATA_DIR and INIT_CWD come from (default `process.env`). */
  env?: NodeJS.ProcessEnv
}

/** The CLI (exported for tests): an expected `BackupError` is reported as a `CliError` (no stack trace). */
export async function main(args: string[], { env = process.env }: BackupCliOptions = {}): Promise<void> {
  if (args.length > 1) throw new CliError('Usage: npm run backup -- [outDir]')
  const dataDir = cliDataDir(env)
  // npm runs scripts from apps/server; a relative outDir means relative to where the operator typed it
  const outDir = args[0] === undefined ? undefined : path.resolve(env.INIT_CWD ?? process.cwd(), args[0])
  let result
  try {
    result = await runBackup({ dataDir, outDir })
  } catch (err) {
    if (err instanceof BackupError) throw new CliError(err.message)
    throw err
  }
  for (const name of result.missing) console.warn(`warning: attachment file ${name} is missing; not in the archive`)
  console.log(`Backup written to ${result.dir} (${DB_FILE_NAME} + ${UPLOADS_ARCHIVE_NAME}, ${result.files} files)`)
}

runIfInvokedDirectly(import.meta.url, (args) => main(args))
