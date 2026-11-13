// `npm run backup:offsite`: one off-site backup on demand. It reads only DATA_DIR and the BACKUP_* settings
// (no server secrets), uploads one backup to the fake S3 server (never real R2), prints its name, and never
// touches the scheduler's state file or prunes anything.
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main as backupOffsiteMain } from '../src/cli/backup-offsite.js'
import { CliError } from '../src/cli/common.js'
import { DB_FILE_NAME, openDataDb } from '../src/db/index.js'
import { storeUpload } from '../src/services/attachments.js'
import { MANIFEST_NAME, OFFSITE_STATE_FILE } from '../src/services/offsiteBackup.js'
import { PNG, tmpDataDir } from './helpers/api.js'
import { seedUser } from './helpers/auth.js'
import { FakeS3, offsiteEnv } from './helpers/fakeS3.js'

const NOW = new Date('2026-11-13T09:30:15.000Z')
const NAME = 'notes-backup-20261113-093015'
const SECRET = 'cli-secret-access-key-value'

let dataDir: string
let fake: FakeS3
let log: string[]

/** The operator's environment: DATA_DIR and BACKUP_* only (no SESSION_SECRET, SHARE_HMAC_KEY, PUBLIC_ORIGIN). */
function backupEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return offsiteEnv(dataDir, {
    BACKUP_S3_ACCESS_KEY_ID: 'AKIDCLIKEY',
    BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
    BACKUP_S3_PREFIX: 'custom',
    ...overrides,
  })
}

beforeEach(async () => {
  dataDir = tmpDataDir()
  const db = openDataDb(dataDir)
  const userId = seedUser(db, 'alice@example.com')
  await storeUpload(db, dataDir, userId, { originalName: 'a.png', data: PNG })
  db.close()
  fake = await new FakeS3().start()
  log = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.join(' '))
  })
  // the CLI refuses to run as root; these tests must pass whoever runs them
  vi.spyOn(process, 'getuid').mockReturnValue(1000)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fake.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

const run = (args: string[] = [], env = backupEnv()) =>
  backupOffsiteMain(args, { env, endpoint: fake.endpoint, now: NOW })

describe('backup:offsite CLI', () => {
  it('refuses to run as root, before touching the database, and names the setpriv command', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const err = await run().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toContain(
      'setpriv --reuid=1000 --regid=1000 --clear-groups npm --prefix /app/apps/server run backup:offsite',
    )
    expect(fake.requests).toEqual([])
    expect(existsSync(path.join(dataDir, `${DB_FILE_NAME}-wal`))).toBe(false)
  })

  it('uploads one backup with the BACKUP_* settings alone and prints its name', async () => {
    await run()

    expect(fake.keys()).toEqual([
      `custom/${NAME}/${MANIFEST_NAME}`,
      `custom/${NAME}/${DB_FILE_NAME}`,
      `custom/${NAME}/uploads.tar.gz`,
    ])
    // signed with the configured key and region (R2's default `auto`)
    const auth = String(fake.requests[0]!.headers.authorization)
    expect(auth).toContain('Credential=AKIDCLIKEY/')
    expect(auth).toContain('/auto/s3/aws4_request')
    expect(log.join('\n')).toContain(NAME)
    expect(log.join('\n')).not.toContain(SECRET)
  })

  it('never writes the state file and never lists or prunes the bucket', async () => {
    // a complete backup far past BACKUP_KEEP_DAYS: the scheduler would prune it, the CLI must not
    const old = 'custom/notes-backup-20200101-000000'
    for (const file of ['uploads.tar.gz', DB_FILE_NAME, MANIFEST_NAME]) fake.put(`${old}/${file}`, 'x')

    await run([], backupEnv({ BACKUP_KEEP_DAYS: '1' }))

    expect(existsSync(path.join(dataDir, OFFSITE_STATE_FILE))).toBe(false)
    expect(fake.requests.map((r) => r.method)).toEqual(['PUT', 'PUT', 'PUT'])
    expect(fake.keys().filter((key) => key.startsWith(old))).toHaveLength(3)
  })

  it('refuses with a CliError when off-site backups are not configured', async () => {
    const err = await run([], { DATA_DIR: dataDir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toMatch(/not configured.*BACKUP_S3_ENDPOINT/s)
    expect(fake.requests).toEqual([])
  })

  it('reports a partial configuration as a CliError naming what is missing', async () => {
    const err = await run([], backupEnv({ BACKUP_S3_SECRET_ACCESS_KEY: undefined })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toContain('missing: BACKUP_S3_SECRET_ACCESS_KEY')
    expect(fake.requests).toEqual([])
  })

  it('reports an S3 failure as a CliError without credentials', async () => {
    fake.intercept = (_req, res) => {
      fake.error(res, 403, 'AccessDenied', 'Access Denied')
      return true
    }
    const err = await run().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toContain('AccessDenied')
    expect((err as Error).message).not.toContain(SECRET)
    expect(existsSync(path.join(dataDir, OFFSITE_STATE_FILE))).toBe(false)
  })

  it('reports an unreachable endpoint as a CliError, like restore:offsite does', async () => {
    const endpoint = fake.endpoint
    await fake.stop()
    const err = await backupOffsiteMain([], { env: backupEnv(), endpoint, now: NOW }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toMatch(/^Off-site backup failed: .*ECONNREFUSED/)
  })

  it('reports a missing database as a CliError', async () => {
    rmSync(path.join(dataDir, DB_FILE_NAME))
    await expect(run()).rejects.toThrow(CliError)
    expect(fake.requests).toEqual([])
  })

  it('refuses arguments with its usage line', async () => {
    await expect(run(['extra'])).rejects.toThrow('Usage: npm run backup:offsite')
  })
})
