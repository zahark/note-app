import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../src/errors.js'
import { HashLimiter } from '../src/services/hashLimiter.js'
import {
  changePassword,
  closeApp,
  cookieValue,
  errorCode,
  login,
  makeApp,
  PASSWORD,
  seedUser,
  signup,
  type TestApp,
} from './helpers/auth.js'

/** A task that runs until `done()` is called; `running` tells whether it has started. */
function gatedTask() {
  let finish!: () => void
  const finished = new Promise<void>((r) => (finish = r))
  const task = {
    running: false,
    fn: async () => {
      task.running = true
      await finished
      return 'ok'
    },
    done: () => finish(),
  }
  return task
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('HashLimiter', () => {
  it('runs at most 4 general hashes at once; queued work starts as slots free up', async () => {
    const limiter = new HashLimiter({ maxWaitMs: 10_000 })
    const tasks = Array.from({ length: 6 }, gatedTask)
    const results = tasks.map((task) => limiter.run(task.fn))
    await tick()
    expect(tasks.filter((x) => x.running)).toHaveLength(4)

    tasks[0]?.done()
    await tick()
    expect(tasks.filter((x) => x.running)).toHaveLength(5)

    for (const task of tasks) task.done()
    await expect(Promise.all(results)).resolves.toEqual(Array(6).fill('ok'))
    // every slot was returned: 4 new tasks start at once
    const again = Array.from({ length: 4 }, gatedTask)
    const againResults = again.map((task) => limiter.run(task.fn))
    await tick()
    expect(again.filter((x) => x.running)).toHaveLength(4)
    for (const task of again) task.done()
    await Promise.all(againResults)
  })

  it('general work never uses the reserved slot; it waits briefly, then gets 503', async () => {
    const limiter = new HashLimiter({ maxWaitMs: 20 })
    const held = Array.from({ length: 4 }, gatedTask)
    const heldResults = held.map((task) => limiter.run(task.fn))
    await tick()

    const err = await limiter.run(async () => 'never').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).statusCode).toBe(503)

    // owner-eligible work takes the reserved slot immediately
    await expect(limiter.run(async () => 'owner', { reserved: true })).resolves.toBe('owner')

    for (const task of held) task.done()
    await Promise.all(heldResults)
  })

  it('a freed reserved slot goes to a reserved waiter, never to a general one', async () => {
    const limiter = new HashLimiter({ maxWaitMs: 10_000 })
    const held = Array.from({ length: 4 }, gatedTask)
    const heldResults = held.map((task) => limiter.run(task.fn))
    const owner1 = gatedTask()
    const owner1Result = limiter.run(owner1.fn, { reserved: true })
    await tick()
    expect(owner1.running).toBe(true)

    const general = gatedTask()
    const owner2 = gatedTask()
    const generalResult = limiter.run(general.fn)
    const owner2Result = limiter.run(owner2.fn, { reserved: true })
    owner1.done()
    await owner1Result
    await tick()
    expect(owner2.running).toBe(true)
    expect(general.running).toBe(false)

    for (const task of [...held, general, owner2]) task.done()
    await Promise.all([...heldResults, generalResult, owner2Result])
  })
})

describe('reserved owner slot (HTTP)', () => {
  const BLOCK = 'blocked password!'
  let t: TestApp
  let ownerDid: string
  let secondDid: string
  let ownerSid: string
  let secondSid: string

  beforeEach(async () => {
    t = await makeApp({ hashWaitMs: 50, env: { ALLOW_SIGNUP: 'true' } })
    seedUser(t.db, 'owner@example.com')
    seedUser(t.db, 'second@example.com')
    const ownerLogin = await login(t.app, { email: 'owner@example.com' })
    const secondLogin = await login(t.app, { email: 'second@example.com' })
    ownerDid = cookieValue(ownerLogin, 'did')
    ownerSid = cookieValue(ownerLogin, 'sid')
    secondDid = cookieValue(secondLogin, 'did')
    secondSid = cookieValue(secondLogin, 'sid')
    t.hasher.blocked.add(BLOCK)
  })

  afterEach(async () => {
    await closeApp(t)
  })

  /** Occupies all 4 general slots with 2 signups and 2 unknown-email logins whose hashing blocks. */
  async function holdGeneralSlots() {
    const held = [
      signup(t.app, { email: 'new1@example.com', password: BLOCK, ip: '203.0.113.1' }),
      signup(t.app, { email: 'new2@example.com', password: BLOCK, ip: '203.0.113.2' }),
      login(t.app, { email: 'ghost1@example.com', password: BLOCK, ip: '203.0.113.3' }),
      login(t.app, { email: 'ghost2@example.com', password: BLOCK, ip: '203.0.113.4' }),
    ]
    await vi.waitFor(() => expect(t.hasher.active).toBe(4))
    return held
  }

  it('the owner login with a valid owner device cookie succeeds while all general slots are held', async () => {
    const held = await holdGeneralSlots()
    const res = await login(t.app, { email: 'owner@example.com', cookies: { did: ownerDid } })
    expect(res.statusCode).toBe(200)
    t.hasher.release()
    expect((await Promise.all(held)).map((r) => r.statusCode)).toEqual([201, 201, 401, 401])
  })

  it('a non-owner flooding device-cookie logins cannot take the reserved slot; the owner still gets in', async () => {
    const held = await holdGeneralSlots()
    const flood = Array.from({ length: 5 }, (_, i) =>
      login(t.app, { email: 'second@example.com', ip: `192.0.2.${i + 1}`, cookies: { did: secondDid } }),
    )
    const owner = await login(t.app, { email: 'owner@example.com', cookies: { did: ownerDid } })
    expect(owner.statusCode).toBe(200)
    const floodResults = await Promise.all(flood)
    for (const res of floodResults) {
      expect(res.statusCode).toBe(503)
      expect(errorCode(res)).toBe('BUSY')
    }
    t.hasher.release()
    await Promise.all(held)
  })

  it('a non-owner flooding change-password cannot take the reserved slot; the owner known-device login still succeeds', async () => {
    const held = await holdGeneralSlots()
    const flood = Array.from({ length: 5 }, () =>
      changePassword(t.app, { sid: secondSid, newPassword: 'flooded new password' }),
    )
    const owner = await login(t.app, { email: 'owner@example.com', ip: '192.0.2.50', cookies: { did: ownerDid } })
    expect(owner.statusCode).toBe(200)
    const floodResults = await Promise.all(flood)
    for (const res of floodResults) {
      expect(res.statusCode).toBe(503)
      expect(errorCode(res)).toBe('BUSY')
    }
    // nothing changed for the flooding account
    expect(t.db.prepare('SELECT password_hash FROM users WHERE email = ?').pluck().get('second@example.com')).toBe(
      `fake$${PASSWORD}`,
    )
    t.hasher.release()
    await Promise.all(held)
  })

  it('the owner’s own change-password can use the reserved slot while all general slots are held', async () => {
    const held = await holdGeneralSlots()
    const res = await changePassword(t.app, { sid: ownerSid, newPassword: 'owner new password' })
    expect(res.statusCode).toBe(204)
    expect(t.db.prepare('SELECT password_hash FROM users WHERE email = ?').pluck().get('owner@example.com')).toBe(
      'fake$owner new password',
    )
    t.hasher.release()
    await Promise.all(held)
  })

  it('an owner login without a device cookie, or with another account’s cookie, cannot use the reserved slot', async () => {
    const held = await holdGeneralSlots()
    expect((await login(t.app, { email: 'owner@example.com' })).statusCode).toBe(503)
    expect(
      (await login(t.app, { email: 'owner@example.com', ip: '192.0.2.9', cookies: { did: secondDid } })).statusCode,
    ).toBe(503)
    t.hasher.release()
    await Promise.all(held)
  })
})
