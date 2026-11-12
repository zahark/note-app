/**
 * Browser file downloads: saving a blob under a file name through a temporary anchor, and reading the
 * server's file name from `Content-Disposition`.
 */

import { FILE_TYPES } from './fileTypes'

/** How long a downloaded blob's URL stays valid: revoking it right after the click can cancel the save in some browsers. */
const DOWNLOAD_URL_TTL_MS = 60_000

/** Clicks a temporary, hidden `<a href download>`: the browser saves `href` as `name` and stays on the page. */
export function clickDownload(href: string, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * Saves `blob` as `name` through a blob URL that is revoked after `DOWNLOAD_URL_TTL_MS`. The URL's
 * type is `application/octet-stream`, so even opened directly it would never render on the app's origin.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
  clickDownload(url, name)
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS)
}

/**
 * The file name from a `Content-Disposition` header: the RFC 5987 `filename*=UTF-8''…` form the server
 * sends, else the plain `filename="…"`; null when there is none or it cannot be decoded. Both are
 * matched only at a parameter start, so text inside the quoted `filename` (`a filename*=UTF-8''x.exe`)
 * is never taken for the extended parameter.
 */
export function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(header)
  if (extended) {
    try {
      const name = decodeURIComponent(extended[1]!)
      if (name) return name
    } catch {
      // malformed encoding: fall back to the plain form
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*"([^"]*)"/i.exec(header)
  return plain?.[1] ? plain[1] : null
}

/** The download extension of each file type the app saves (the server's `attachmentResponseHeaders`). */
const FILE_EXTENSIONS: ReadonlyMap<string, string> = new Map(
  Object.values(FILE_TYPES).map(({ mime, extension }) => [mime, extension]),
)

/** Why a file download was refused: the response is not a PDF or GPX named as one. */
const NOT_A_FILE_MESSAGE = 'it is not a PDF or GPX file'

/** A download refused because the server did not answer with a PDF or GPX file named as one. */
export class DownloadRefusedError extends Error {
  constructor() {
    super(NOT_A_FILE_MESSAGE)
    this.name = 'DownloadRefusedError'
  }
}

/**
 * The name to save a file attachment response under: always the server's (`Content-Disposition`), and
 * only when the response is a PDF or GPX (`Content-Type`) whose name ends in that type's extension;
 * null otherwise (an image, or a header missing or unparseable). The caller then refuses the download
 * (`DownloadRefusedError`): the name in the note content is never a download name.
 */
export function fileDownloadName(headers: Headers): string | null {
  const type = (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const extension = FILE_EXTENSIONS.get(type)
  const name = fileNameFromDisposition(headers.get('content-disposition'))
  if (!extension || !name || !name.toLowerCase().endsWith(extension)) return null
  return name
}
