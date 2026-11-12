/**
 * The non-image attachment kinds (a file node's `kind`): the MIME type the server stores and serves for
 * each, and the extension its download name always ends in (the server's `KINDS`/`MIME_EXTENSIONS` in
 * `services/attachments.ts`). The upload picker's `accept` list, the upload guess and the download
 * check are all derived from this table.
 */
export const FILE_TYPES = {
  pdf: { mime: 'application/pdf', extension: '.pdf' },
  gpx: { mime: 'application/gpx+xml', extension: '.gpx' },
} as const

export type FileKind = keyof typeof FILE_TYPES

/** Every file kind, in table order. */
export const FILE_KINDS = Object.keys(FILE_TYPES) as FileKind[]
