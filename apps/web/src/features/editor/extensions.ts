import type { Extensions, JSONContent } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { AttachmentImage, type AttachmentResolver } from './AttachmentImage'

export interface EditorExtensionOptions {
  /** Maps `attachment://<aid>` to a loadable URL inside the image node view. */
  resolveAttachment: AttachmentResolver | null
  /** Empty-document hint (editable editors only). */
  placeholder?: string
}

/**
 * The note schema, shared by the owner's editor and the read-only shared view: StarterKit (whose
 * input rules give markdown shortcuts such as `# `, `- `, `1. `, `> `, `**bold**`, and which
 * includes links), task lists (`[ ] `) and `attachment://` images.
 */
export function editorExtensions({ resolveAttachment, placeholder }: EditorExtensionOptions): Extensions {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    AttachmentImage.configure({ resolveAttachment }),
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
