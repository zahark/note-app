// Server entry point: validate config (refusing to boot on bad config), build the app, listen.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { buildApp, defaultWebDir } from './app.js'
import { ConfigError, loadConfig, type Config } from './config.js'
import { openDataDb } from './db/index.js'
import { offsiteBackupTarget } from './services/offsiteBackup.js'
import { HOUR_MS } from './units.js'

async function main(): Promise<void> {
  let config: Config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }

  // opening the database runs any pending migrations, so the schema is current before listening
  const db = openDataDb(config.dataDir)
  // the built SPA is served from apps/web/dist when present; without it (e.g. `npm run dev`, where Vite
  // serves the web app) the server answers the API only
  const webDir = defaultWebDir()
  const hasWebBuild = existsSync(path.join(webDir, 'index.html'))
  const app = buildApp({
    config,
    db,
    logger: { level: config.logLevel },
    attachmentSweep: true,
    offsiteBackup: config.offsiteBackup !== null,
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
  if (!hasWebBuild) app.log.warn(`no web build at ${webDir}; serving the API only`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  }

  await app.listen({ host: config.host, port: config.port })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
