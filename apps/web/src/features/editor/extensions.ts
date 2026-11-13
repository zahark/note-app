import type { Extensions, JSONContent } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { AttachmentFile, type AttachmentDownloader } from './AttachmentFile'
import { AttachmentImage } from './AttachmentImage'
import type { AttachmentResolver } from './attachmentRef'
import { LinkShortcuts } from './links'
import type { PdfPreviewErrorHandler } from './PdfViewer'
import { AutoTextDirection } from './textDirection'

export interface EditorExtensionOptions {
  /** Maps `attachment://<aid>` to a loadable URL inside the image and file node views. */
  resolveAttachment: AttachmentResolver | null
  /** Downloads a file attachment (the file node's Download button). */
  downloadAttachment: AttachmentDownloader
  /** Told when a PDF preview fails: the owner passes a 401 to `handleUnauthorized` (the shared view needs none). */
  onPreviewError?: PdfPreviewErrorHandler
  /** Empty-document hint (editable editors only). */
  placeholder?: string
}

/**
 * The note schema, shared by the owner's editor and the read-only shared view: StarterKit (whose
 * input rules give markdown shortcuts such as `# `, `- `, `1. `, `> `, `**bold**`, and which
 * includes links), task lists (`[ ] `), `attachment://` images and `attachment://` files (PDF, GPX).
 * Links never open on a plain click while editing (that places the cursor; the owner's `LinkPopover`
 * offers Open), but do on Cmd/Ctrl+click (`LinkShortcuts`); in the read-only shared view a plain
 * click follows the link's `target="_blank"`. Each block runs left-to-right or right-to-left by its
 * first letter (`AutoTextDirection`).
 */
export function editorExtensions({
  resolveAttachment,
  downloadAttachment,
  onPreviewError,
  placeholder,
}: EditorExtensionOptions): Extensions {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    LinkShortcuts,
    AutoTextDirection,
    TaskList,
    TaskItem.configure({ nested: true }),
    AttachmentImage.configure({ resolveAttachment }),
    AttachmentFile.configure({ resolveAttachment, downloadAttachment, onPreviewError: onPreviewError ?? null }),
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ]
}

/**
 * Stored content as the editor should load it. A new note is stored as `{type:'doc', content:[]}`,
 * which the schema (`block+`) does not allow and ProseMirror would render as nothing at all, not even
 * a line to type on: give such a document its empty paragraph.
 */
export function toEditorContent(content: JSONContent | null | undefined): JSONContent {
  if (!content || content.type !== 'doc' || !Array.isArray(content.content) || content.content.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }
  return content
}
