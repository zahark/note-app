import { serviceUnavailable } from '../errors.js'

export const GENERAL_HASH_SLOTS = 4
export const RESERVED_HASH_SLOTS = 1
/** How long a hash request may wait for a free slot before it is refused with 503. */
export const DEFAULT_HASH_WAIT_MS = 2000

export interface HashLimiterOptions {
  general?: number
  reserved?: number
  maxWaitMs?: number
}

export interface HashRunOptions {
  /**
   * True only for the owner account on a known device (owner login with a valid owner device cookie,
   * or a change-password from an owner session). Only such work may use the reserved slot.
   */
  reserved?: boolean
}

type SlotKind = 'general' | 'reserved'

interface Waiter {
  reservedOk: boolean
  grant: (kind: SlotKind) => void
}

/**
 * Global concurrency cap for argon2 work: `general` slots serve every hash; `reserved` slots may only be
 * used by owner-eligible work, so anonymous hashing or floods from other accounts can never 503 the owner
 * on a known device. Work that finds no slot waits up to `maxWaitMs`, then gets a 503.
 */
export class HashLimiter {
  readonly general: number
  readonly reserved: number
  private readonly maxWaitMs: number
  private generalInUse = 0
  private reservedInUse = 0
  private readonly queue: Waiter[] = []

  constructor({
    general = GENERAL_HASH_SLOTS,
    reserved = RESERVED_HASH_SLOTS,
    maxWaitMs = DEFAULT_HASH_WAIT_MS,
  }: HashLimiterOptions = {}) {
    this.general = general
    this.reserved = reserved
    this.maxWaitMs = maxWaitMs
  }

  get inUse(): { general: number; reserved: number } {
    return { general: this.generalInUse, reserved: this.reservedInUse }
  }

  async run<T>(fn: () => Promise<T>, { reserved = false }: HashRunOptions = {}): Promise<T> {
    const kind = await this.acquire(reserved)
    try {
      return await fn()
    } finally {
      this.release(kind)
    }
  }

  private acquire(reservedOk: boolean): Promise<SlotKind> {
    if (this.generalInUse < this.general) {
      this.generalInUse++
      return Promise.resolve('general')
    }
    if (reservedOk && this.reservedInUse < this.reserved) {
      this.reservedInUse++
      return Promise.resolve('reserved')
    }
    return new Promise<SlotKind>((resolve, reject) => {
      const waiter: Waiter = {
        reservedOk,
        grant: (kind) => {
          clearTimeout(timer)
          resolve(kind)
        },
      }
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter)
        if (i >= 0) this.queue.splice(i, 1)
        reject(serviceUnavailable())
      }, this.maxWaitMs)
      this.queue.push(waiter)
    })
  }

  /** Hands the freed slot to the first waiter allowed to use it, or returns it to the pool. */
  private release(kind: SlotKind): void {
    const i = kind === 'general' ? (this.queue.length > 0 ? 0 : -1) : this.queue.findIndex((w) => w.reservedOk)
    const next = i >= 0 ? this.queue.splice(i, 1)[0] : undefined
    if (next) {
      next.grant(kind)
      return
    }
    if (kind === 'general') this.generalInUse--
    else this.reservedInUse--
  }
}
