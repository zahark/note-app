// Server entry point: validate config (refusing to boot on bad config), prepare the server (a staged
// restore first, then the database and the app; see startup.ts), listen.
import type { FastifyInstance } from 'fastify'
import { ConfigError, loadConfig, type Config } from './config.js'
import { RestoreError } from './services/restore.js'
import { prepareServer } from './startup.js'

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

  let app: FastifyInstance
  try {
    app = prepareServer(config)
  } catch (err) {
    // the database was not opened; the message says how to cancel the restore
    if (err instanceof RestoreError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }

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
