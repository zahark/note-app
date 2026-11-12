import { useEffect, useRef, useState, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { NodeSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ShareButton } from '@/features/share/ShareDialog'
import { ApiError, errorMessage, isNotFound } from '@/lib/api'
import { handleUnauthorized } from '@/lib/queryClient'
import {
  ACCEPTED_FILE_TYPES,
  ACCEPTED_IMAGE_TYPES,
  checkUploadFile,
  downloadOwnerAttachment,
  ownerAttachmentUrl,
  uploadAttachment,
  useNote,
  type Note,
  type UploadedAttachment,
} from './api'
import { attachmentSrc } from './attachmentRef'
import { ConflictPrompt } from './ConflictPrompt'
import { editorExtensions, toEditorContent } from './extensions'
import { SaveIndicator } from './SaveIndicator'
import { TitleField } from './TitleField'
import { Toolbar } from './Toolbar'
import { useAutosave } from './useAutosave'

interface NotePaneProps {
  noteId: string
  /** Closes the note (e.g. it no longer exists). */
  onClose: () => void
}

/**
 * The main pane for an open note: loading and error states, then the title field and the editor.
 * Render it with `key={noteId}` so each note gets a fresh editor and autosave.
 */
export function NotePane({ noteId, onClose }: NotePaneProps) {
  const note = useNote(noteId)
  // bumped after a conflict reload, to remount the editor on the fresh content
  const [generation, setGeneration] = useState(0)

  if (note.isPending) return <NoteSkeleton />
  if (note.isError) {
    const missing = isNotFound(note.error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm">
        <p className="text-muted-foreground">
          {missing ? 'This note does not exist or was deleted.' : 'Could not load this note.'}
        </p>
        {missing ? (
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => note.refetch()}>
            Retry
          </Button>
        )}
      </div>
    )
  }

  const reload = async () => {
    const result = await note.refetch()
    if (result.isSuccess) setGeneration((g) => g + 1)
    else toast.error(`Could not reload the note: ${errorMessage(result.error)}`)
  }

  return <NoteEditor key={generation} note={note.data} onReload={reload} />
}

function NoteSkeleton() {
  return (
    <div role="status" aria-label="Loading note" className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="h-8 w-1/2 animate-pulse rounded bg-muted" />
      {[90, 75, 85, 60].map((width, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
      ))}
    </div>
  )
}

interface NoteEditorProps {
  note: Note
  /** Refetches the note and remounts the editor (after a conflict). */
  onReload: () => Promise<void>
}

function NoteEditor({ note, onReload }: NoteEditorProps) {
  const { status, schedule, error: saveError } = useAutosave({ noteId: note.id, version: note.version })
  const queryClient = useQueryClient()
  const upload = useMutation({ mutationFn: uploadAttachment })
  const [uploading, setUploading] = useState(0)
  const imageInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /**
   * Uploads each file, then inserts it (at `pos`, or at the cursor) as `attachment://<aid>`: an image
   * node for an image, a file node for a PDF or GPX, by the kind the server detected from the content
   * (a renamed file still gets the right node). A selected node (such as the attachment inserted
   * just before) is kept: the new one goes after it instead of replacing it. A rate limit or full
   * storage stops the batch with one message instead of one per remaining file.
   */
  const insertAttachments = async (editor: Editor, files: File[], pos?: number) => {
    let at = pos
    for (const [index, file] of files.entries()) {
      const problem = checkUploadFile(file)
      if (problem !== null) {
        toast.error(problem)
        continue
      }
      setUploading((n) => n + 1)
      try {
        const uploaded = await upload.mutateAsync(file)
        if (editor.isDestroyed) return
        const node = attachmentNode(uploaded, file)
        const { selection } = editor.state
        if (at === undefined && selection instanceof NodeSelection) {
          editor.chain().focus().insertContentAt(selection.to, node).run()
        } else if (at === undefined) {
          editor.chain().focus().insertContent(node).run()
        } else {
          // the document may have changed during the upload
          editor.chain().insertContentAt(Math.min(at, editor.state.doc.content.size), node).run()
          at = editor.state.selection.to
        }
      } catch (err) {
        const stop = err instanceof ApiError && (err.status === 429 || err.code === 'QUOTA_EXCEEDED')
        const skipped = stop ? files.length - index - 1 : 0
        const rest = skipped > 0 ? ` (${skipped} more not uploaded)` : ''
        toast.error(`Could not upload ${file.name || 'the file'}: ${errorMessage(err)}${rest}`)
        if (stop) return
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }
  // the editor's paste/drop handlers are created once; they call the latest version through this ref
  const insertAttachmentsRef = useRef(insertAttachments)
  useEffect(() => {
    insertAttachmentsRef.current = insertAttachments
  })

  const editor = useEditor({
    extensions: editorExtensions({
      resolveAttachment: ownerAttachmentUrl,
      downloadAttachment: (aid, displayName) => {
        downloadOwnerAttachment(aid).catch((err: unknown) => {
          handleUnauthorized(queryClient, err)
          toast.error(`Could not download ${displayName}: ${errorMessage(err)}`)
        })
      },
      // the viewer shows its own error; an expired session still goes to login, as for any request
      onPreviewError: (err) => handleUnauthorized(queryClient, err),
      placeholder: 'Start writing…',
    }),
    content: toEditorContent(note.content),
    onUpdate: ({ editor: e }) => schedule(e.getJSON()),
    editorProps: {
      attributes: { class: 'note-content', 'aria-label': 'Note content' },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return false
        const e = editorFromView(view)
        if (e) void insertAttachmentsRef.current(e, files)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length === 0) return false
        event.preventDefault()
        const e = editorFromView(view)
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        if (e) void insertAttachmentsRef.current(e, files, pos)
        return true
      },
    },
  })

  // edits after a conflict could never be saved: stop accepting them
  useEffect(() => {
    if (status === 'conflict') editor.setEditable(false)
  }, [status, editor])

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        editor={editor}
        uploading={uploading > 0}
        onInsertImage={() => imageInput.current?.click()}
        onAttachFile={() => fileInput.current?.click()}
      />
      <UploadInput
        inputRef={imageInput}
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        testId="image-file-input"
        onFiles={(files) => void insertAttachments(editor, files)}
      />
      <UploadInput
        inputRef={fileInput}
        accept={ACCEPTED_FILE_TYPES.join(',')}
        testId="attach-file-input"
        onFiles={(files) => void insertAttachments(editor, files)}
      />
      {status === 'conflict' && <ConflictPrompt editor={editor} onReload={onReload} />}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <div className="flex items-start gap-3">
            <TitleField noteId={note.id} loadedTitle={note.title} onEnter={() => editor.commands.focus('start')} />
            <SaveIndicator status={status} error={saveError} uploading={uploading > 0} />
            <ShareButton note={note} />
          </div>
          <EditorContent editor={editor} className="mt-2" />
        </div>
      </div>
    </div>
  )
}

interface UploadInputProps {
  inputRef: RefObject<HTMLInputElement | null>
  accept: string
  testId: string
  onFiles: (files: File[]) => void
}

/** A hidden multi-file input opened by a toolbar button; it is cleared after each pick so the same file can be picked again. */
function UploadInput({ inputRef, accept, testId, onFiles }: UploadInputProps) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      multiple
      hidden
      data-testid={testId}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ''
        if (files.length) onFiles(files)
      }}
    />
  )
}

/**
 * The node an upload becomes, by the kind the server detected: an image, or a file node (PDF, GPX)
 * carrying the server's stored name (always ending in `.pdf` / `.gpx`, the name downloads get) and
 * size for display.
 */
function attachmentNode({ id, kind, size, name }: UploadedAttachment, file: File) {
  const src = attachmentSrc(id)
  if (kind === 'image') return { type: 'image', attrs: { src, alt: file.name || null } }
  return { type: 'attachmentFile', attrs: { src, name, size, kind } }
}

/** The TipTap editor a ProseMirror view belongs to (TipTap sets `view.dom.editor`). */
function editorFromView(view: { dom: Element }): Editor | undefined {
  return (view.dom as Element & { editor?: Editor }).editor
}
