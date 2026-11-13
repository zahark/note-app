// The uploads tarball reader (`readUploadsArchive`): it must read back exactly what the backup writer
// produces, and refuse anything a restore must never write to disk (paths outside `uploads/`, unsafe
// names, links, directories, duplicates) as well as truncated or corrupt input.
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BackupError,
  readUploadsArchive,
  writeUploadsArchive,
  type ArchiveEntry,
} from '../src/services/backup.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'notes-archive-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Reads an archive, collecting every entry's bytes (consumed in the chunks the reader hands out). */
async function readAll(source: Readable) {
  const files = new Map<string, Buffer>()
  const entries: ArchiveEntry[] = []
  const summary = await readUploadsArchive(source, async (entry, data) => {
    entries.push(entry)
    const chunks: Buffer[] = []
    for await (const chunk of data) chunks.push(chunk)
    files.set(entry.name, Buffer.concat(chunks))
  })
  return { files, entries, summary }
}

/** Writes `files` (storage name → bytes) with the backup writer and returns the archive path. */
async function writeArchive(files: Record<string, Buffer>): Promise<string> {
  const entries = Object.entries(files).map(([storageName, data]) => {
    const file = path.join(dir, `src-${storageName}`)
    writeFileSync(file, data)
    return { storageName, file }
  })
  const archivePath = path.join(dir, 'uploads.tar.gz')
  await writeUploadsArchive(entries, archivePath, 1_700_000_000)
  return archivePath
}

const BLOCK = 512

interface RawEntry {
  name: string
  data?: Buffer
  type?: string
  linkName?: string
  prefix?: string
  /** Overrides the header's size field (the data written stays `data`). */
  size?: number
  magic?: string
  badChecksum?: boolean
}

/** A hand-built ustar header, independent of the code under test, so hostile archives can be crafted. */
function rawHeader(e: RawEntry): Buffer {
  const header = Buffer.alloc(BLOCK)
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0')
  header.write(e.name, 0, 100, 'utf8')
  header.write(octal(0o600, 8), 100, 8, 'ascii')
  header.write(octal(0, 8), 108, 8, 'ascii')
  header.write(octal(0, 8), 116, 8, 'ascii')
  header.write(octal(e.size ?? e.data?.length ?? 0, 12), 124, 12, 'ascii')
  header.write(octal(0, 12), 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write(e.type ?? '0', 156, 1, 'ascii')
  if (e.linkName) header.write(e.linkName, 157, 100, 'utf8')
  header.write(e.magic ?? 'ustar\u0000', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  if (e.prefix) header.write(e.prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  if (e.badChecksum) sum += 1
  header.write(`${octal(sum, 7)}\u0000 `, 148, 8, 'ascii')
  return header
}

/** Raw (uncompressed) tar bytes for `entries`, with the end-of-archive marker unless `end` is false. */
function rawTar(entries: RawEntry[], end = true): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    parts.push(rawHeader(e))
    const data = e.data ?? Buffer.alloc(0)
    parts.push(data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK))
  }
  if (end) parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

/** A gzipped buffer as a stream that hands it out in small chunks, so block boundaries fall mid-chunk. */
function streamOf(bytes: Buffer, chunkSize = 777): Readable {
  const chunks: Buffer[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize))
  return Readable.from(chunks)
}

const gz = (entries: RawEntry[], end = true) => streamOf(gzipSync(rawTar(entries, end)))

describe('readUploadsArchive round trip', () => {
  it('reads back several files written by the backup writer, on and off the 512-byte boundary', async () => {
    const files: Record<string, Buffer> = {
      'a0b1c2.png': Buffer.alloc(BLOCK, 1), // exactly one block
      'block-pair.pdf': Buffer.alloc(BLOCK * 2, 2), // exactly two blocks
      'odd.gpx': Buffer.from('<gpx/>'), // shorter than a block
      'big.bin': Buffer.alloc(300_000 + 17, 3), // many blocks, not aligned
      'empty.txt': Buffer.alloc(0), // zero bytes
    }
    const archivePath = await writeArchive(files)

    const { files: read, entries, summary } = await readAll(createReadStream(archivePath, { highWaterMark: 1000 }))

    expect([...read.keys()]).toEqual(Object.keys(files))
    for (const [name, data] of Object.entries(files)) expect(read.get(name)).toEqual(data)
    expect(entries).toEqual(Object.entries(files).map(([name, data]) => ({ name, size: data.length })))
    const bytes = Object.values(files).reduce((sum, data) => sum + data.length, 0)
    expect(summary).toEqual({ count: 5, bytes })
  })

  it('reads an empty archive as no entries', async () => {
    const archivePath = await writeArchive({})
    const { files, summary } = await readAll(createReadStream(archivePath))
    expect(files.size).toBe(0)
    expect(summary).toEqual({ count: 0, bytes: 0 })
  })

  it('skips the rest of an entry the callback did not consume', async () => {
    const archivePath = await writeArchive({ first: Buffer.alloc(5000, 9), second: Buffer.from('two') })
    const seen: string[] = []
    let second = Buffer.alloc(0)
    const summary = await readUploadsArchive(createReadStream(archivePath), async (entry, data) => {
      seen.push(entry.name)
      if (entry.name === 'first') {
        for await (const _chunk of data) break // read one chunk, then stop
      } else {
        const chunks: Buffer[] = []
        for await (const chunk of data) chunks.push(chunk)
        second = Buffer.concat(chunks)
      }
    })
    expect(seen).toEqual(['first', 'second'])
    expect(second.toString()).toBe('two')
    expect(summary).toEqual({ count: 2, bytes: 5003 })
  })

  it('accepts a name split into the ustar prefix field', async () => {
    const { files } = await readAll(gz([{ prefix: 'uploads', name: 'split.png', data: Buffer.from('x') }]))
    expect(files.get('split.png')?.toString()).toBe('x')
  })

  it('propagates an error thrown by the callback', async () => {
    const archivePath = await writeArchive({ one: Buffer.from('1') })
    await expect(
      readUploadsArchive(createReadStream(archivePath), () => Promise.reject(new Error('disk full'))),
    ).rejects.toThrow('disk full')
  })
})

describe('readUploadsArchive rejects', () => {
  const data = Buffer.from('payload')

  const rejected: [string, RawEntry[], RegExp][] = [
    ['an entry outside uploads/', [{ name: 'notes.db', data }], /outside uploads\//],
    ['a nested path', [{ name: 'uploads/sub/file', data }], /unsafe/],
    ['a .. component', [{ name: 'uploads/../notes.db', data }], /unsafe/],
    ['a bare ..', [{ name: 'uploads/..', data }], /unsafe/],
    ['a bare .', [{ name: 'uploads/.', data }], /unsafe/],
    ['an absolute path', [{ name: '/uploads/abc', data }], /outside uploads\//],
    ['an absolute path in the prefix', [{ prefix: '/data', name: 'uploads/abc', data }], /outside uploads\//],
    ['a name failing SAFE_STORAGE_NAME', [{ name: 'uploads/bad name!', data }], /unsafe/],
    ['an over-long name', [{ name: `uploads/${'a'.repeat(91)}`, data }], /unsafe/],
    ['a directory', [{ name: 'uploads/dir/', type: '5' }], /not a regular file/],
    ['a directory named like a file', [{ name: 'uploads/dir', type: '5' }], /not a regular file/],
    ['a symlink', [{ name: 'uploads/link', type: '2', linkName: '/etc/passwd' }], /not a regular file/],
    ['a hardlink', [{ name: 'uploads/link', type: '1', linkName: 'uploads/other' }], /not a regular file/],
    ['a pax extended header', [{ name: 'PaxHeader/x', type: 'x', data }], /not a regular file/],
    [
      'a duplicate name',
      [
        { name: 'uploads/same', data },
        { name: 'uploads/same', data },
      ],
      /duplicate/,
    ],
    ['a header with a bad checksum', [{ name: 'uploads/abc', data, badChecksum: true }], /checksum/],
    ['a non-ustar header', [{ name: 'uploads/abc', data, magic: 'nope\u0000\u0000' }], /ustar/],
  ]

  it.each(rejected)('%s', async (_label, entries, message) => {
    const err = await readAll(gz(entries)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackupError)
    expect((err as Error).message).toMatch(message)
  })

  it('stops before handing out an unsafe entry', async () => {
    const names: string[] = []
    await expect(
      readUploadsArchive(gz([{ name: 'uploads/ok', data }, { name: 'uploads/../x', data }]), async (entry) => {
        names.push(entry.name)
      }),
    ).rejects.toThrow(BackupError)
    expect(names).toEqual(['ok'])
  })

  it('a tar without the end-of-archive marker', async () => {
    await expect(readAll(gz([{ name: 'uploads/abc', data }], false))).rejects.toThrow(/truncated/)
  })

  it('a tar cut off in the middle of a file', async () => {
    const tar = rawTar([{ name: 'uploads/abc', data: Buffer.alloc(3000, 1) }])
    const err = await readAll(streamOf(gzipSync(tar.subarray(0, BLOCK + 1000)))).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackupError)
    expect((err as Error).message).toMatch(/truncated/)
  })

  it('a tar cut off in the middle of a header', async () => {
    const tar = rawTar([{ name: 'uploads/abc', data }])
    await expect(readAll(streamOf(gzipSync(tar.subarray(0, 100))))).rejects.toThrow(/truncated/)
  })

  it('a size field larger than the data that follows', async () => {
    await expect(readAll(gz([{ name: 'uploads/abc', data, size: 100_000 }], false))).rejects.toThrow(/truncated/)
  })

  it('input that is not gzip', async () => {
    const err = await readAll(streamOf(rawTar([{ name: 'uploads/abc', data }]))).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackupError)
    expect((err as Error).message).toMatch(/gzip/)
  })

  it('a gzip stream cut short', async () => {
    const zipped = gzipSync(rawTar([{ name: 'uploads/abc', data: Buffer.alloc(20_000, 5) }]))
    const err = await readAll(streamOf(zipped.subarray(0, zipped.length - 10))).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackupError)
    expect((err as Error).message).toMatch(/gzip/)
  })

  it('a gzip stream with a corrupted CRC', async () => {
    const zipped = Buffer.from(gzipSync(rawTar([{ name: 'uploads/abc', data }])))
    const at = zipped.length - 6 // CRC32 lives in the trailer's first 4 bytes
    zipped.writeUInt8(zipped.readUInt8(at) ^ 0xff, at)
    const err = await readAll(streamOf(zipped)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackupError)
    expect((err as Error).message).toMatch(/gzip/)
  })

  it('passes an error of the source stream through unchanged', async () => {
    const boom = new Error('connection reset')
    const source = new Readable({
      read() {
        this.destroy(boom)
      },
    })
    await expect(readAll(source)).rejects.toBe(boom)
  })
})
