// What the server does between loading its config and listening, kept out of index.ts so tests can run it:
// apply (or discard) a staged restore, only then open the database, build the app and log how it runs.
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import { buildApp, defaultWebDir } from './app.js'
import type { Config } from './config.js'
import { openDataDb } from './db/index.js'
import { offsiteBackupTarget } from './services/offsiteBackup.js'
import { applyStagedRestore, type RestoreLog } from './services/restore.js'
import { HOUR_MS } from './units.js'

/** The restore runs before the app logger exists, so its few lines go to the console. */
const consoleRestoreLog: RestoreLog = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
}

export interface PrepareServerOptions {
  /** Fastify logger setting (default `{ level: config.logLevel }`; tests pass a stream). */
  logger?: FastifyServerOptions['logger']
  /** Where the restore's lines go (default the console). */
  restoreLog?: RestoreLog
  /** The built web app (default `apps/web/dist` when it holds an `index.html`; `null` = API only). */
  webDir?: string | null
}

/**
 * Prepares the server without listening: a restore staged by `restore:offsite` is swapped in (or, with
 * RESTORE_ABORT, discarded) before the database is opened, never after, because the swap moves `notes.db`
 * aside. Then opens the database (running pending migrations), builds the app with the attachment sweep
 * and the off-site backup scheduler on, and logs whether off-site backups are on. The database closes with
 * the app. Throws a `RestoreError` (without opening the database) when the staged restore cannot be applied.
 */
export function prepareServer(config: Config, options: PrepareServerOptions = {}): FastifyInstance {
  applyStagedRestore(config.dataDir, { abort: config.restoreAbort, log: options.restoreLog ?? consoleRestoreLog })

  const db = openDataDb(config.dataDir)
  // the built SPA is served from apps/web/dist when present; without it (e.g. `npm run dev`, where Vite
  // serves the web app) the server answers the API only
  const webDir = options.webDir === undefined ? defaultWebDir() : options.webDir
  const hasWebBuild = webDir !== null && existsSync(path.join(webDir, 'index.html'))
  const app = buildApp({
    config,
    db,
    logger: options.logger ?? { level: config.logLevel },
    attachmentSweep: true,
    offsiteBackup: true,
    webDir: hasWebBuild ? webDir : undefined,
  })
  app.addHook('onClose', async () => {
    db.close()
  })
  app.log.info('notes-app server starting')
  if (config.offsiteBackup) {
    const { intervalMs, keepDays } = config.offsiteBackup
    app.log.info(
      { ...offsiteBackupTarget(config.offsiteBackup), intervalHours: intervalMs / HOUR_MS, keepDays },
      'off-site backups on',
    )
  } else {
    app.log.info('off-site backups off (BACKUP_S3_* not set)')
  }
  if (!hasWebBuild && webDir !== null) app.log.warn(`no web build at ${webDir}; serving the API only`)
  return app
}
