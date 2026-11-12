// Server entry point: validate config (refusing to boot on bad config), build the app, listen.
import { buildApp } from './app.js'
import { ConfigError, loadConfig, type Config } from './config.js'
import { appInfo } from './meta.js'

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

  const app = buildApp({ config, logger: true })
  const { name, version } = appInfo()
  app.log.info(`${name} server ${version} starting`)

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
