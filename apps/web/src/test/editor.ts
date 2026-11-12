import { Editor, type JSONContent } from '@tiptap/core'
import { act } from '@testing-library/react'
import type { AttachmentDownloader } from '@/features/editor/AttachmentFile'
import type { AttachmentResolver } from '@/features/editor/attachmentRef'
import { editorExtensions } from '@/features/editor/extensions'

/** The owner's resolver, as `NotePane` passes it. */
export const ownerResolver: AttachmentResolver = (aid) => `/api/attachments/${aid}`

/** A TipTap `doc` with `content`. */
export const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })

/** An `attachmentFile` node with `src`; `name`, `size` and `kind` default to a 2 KB `route.gpx`. */
export const fileNode = (
  src: string,
  attrs: { name?: string | null; size?: number | null; kind?: string | null } = {},
): JSONContent => ({
  type: 'attachmentFile',
  attrs: { src, name: 'route.gpx', size: 2048, kind: 'gpx', ...attrs },
})

/** Every file node's attrs in a TipTap JSON document. */
export function fileNodes(json: JSONContent): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (node: JSONContent) => {
    if (node.type === 'attachmentFile') out.push({ ...node.attrs })
    node.content?.forEach(walk)
  }
  walk(json)
  return out
}

const editors: Editor[] = []

/**
 * An editor with the note schema (`editorExtensions`, the owner's resolver by default), attached to
 * the document and created inside `act` (a PDF node mounts a React viewer). `destroyEditors` removes it.
 */
export function makeEditor(
  content: JSONContent | undefined,
  {
    resolveAttachment = ownerResolver,
    downloadAttachment = () => {},
    editable = true,
  }: { resolveAttachment?: AttachmentResolver | null; downloadAttachment?: AttachmentDownloader; editable?: boolean } = {},
): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  let editor!: Editor
  act(() => {
    editor = new Editor({ element, editable, extensions: editorExtensions({ resolveAttachment, downloadAttachment }), content })
  })
  editors.push(editor)
  return editor
}

/** Destroys every editor `makeEditor` created (inside `act`, so mounted viewers unmount) and empties the body. */
export async function destroyEditors(): Promise<void> {
  await act(async () => {
    while (editors.length) editors.pop()!.destroy()
  })
  document.body.innerHTML = ''
}
