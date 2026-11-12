import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { AlertTriangleIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ShareButton } from '@/features/share/ShareDialog'
import { errorMessage, useTree } from '@/features/tree/api'
import { useRenameNote } from '@/features/tree/mutations'
import { ApiError } from '@/lib/api'
import { ACCEPTED_IMAGE_TYPES, imageFileProblem, imageFilesFrom, ownerAttachmentUrl, uploadAttachment, useNote, type Note } from './api'
import { attachmentSrc } from './AttachmentImage'
import { editorExtensions, toEditorContent } from './extensions'
import { Toolbar } from './Toolbar'
import { useAutosave, type SaveStatus } from './useAutosave'

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
    const missing = note.error instanceof ApiError && note.error.status === 404
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
  const { status, schedule } = useAutosave({ noteId: note.id, version: note.version })
  const upload = useMutation({ mutationFn: uploadAttachment })
  const [uploading, setUploading] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  /** Uploads each image, then inserts it (at `pos`, or at the cursor) as `attachment://<aid>`. */
  const insertImages = async (editor: Editor, files: File[], pos?: number) => {
    let at = pos
    for (const file of files) {
      const problem = imageFileProblem(file)
      if (problem) {
        toast.error(problem)
        continue
      }
      setUploading((n) => n + 1)
      try {
        const aid = await upload.mutateAsync(file)
        if (editor.isDestroyed) return
        const node = { type: 'image', attrs: { src: attachmentSrc(aid), alt: file.name || null } }
        if (at === undefined) {
          editor.chain().focus().insertContent(node).run()
        } else {
          // the document may have changed during the upload
          editor.chain().insertContentAt(Math.min(at, editor.state.doc.content.size), node).run()
          at = editor.state.selection.to
        }
      } catch (err) {
        toast.error(`Could not upload ${file.name || 'the image'}: ${errorMessage(err)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }
  // the editor's paste/drop handlers are created once; they call the latest version through this ref
  const insertImagesRef = useRef(insertImages)
  useEffect(() => {
    insertImagesRef.current = insertImages
  })

  const editor = useEditor({
    extensions: editorExtensions({ resolveAttachment: ownerAttachmentUrl, placeholder: 'Start writing…' }),
    content: toEditorContent(note.content),
    onUpdate: ({ editor: e }) => schedule(e.getJSON()),
    editorProps: {
      attributes: { class: 'note-content', 'aria-label': 'Note content' },
      handlePaste: (view, event) => {
        const files = imageFilesFrom(event.clipboardData)
        if (files.length === 0) return false
        const e = editorFromView(view)
        if (e) void insertImagesRef.current(e, files)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = imageFilesFrom(event.dataTransfer)
        if (files.length === 0) return false
        event.preventDefault()
        const e = editorFromView(view)
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        if (e) void insertImagesRef.current(e, files, pos)
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
      <Toolbar editor={editor} uploading={uploading > 0} onInsertImage={() => fileInput.current?.click()} />
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        multiple
        hidden
        data-testid="image-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length) void insertImages(editor, files)
        }}
      />
      {status === 'conflict' && <ConflictPrompt editor={editor} onReload={onReload} />}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <div className="flex items-start gap-3">
            <TitleField noteId={note.id} loadedTitle={note.title} onEnter={() => editor.commands.focus('start')} />
            <SaveIndicator status={status} uploading={uploading > 0} />
            <ShareButton note={note} />
          </div>
          <EditorContent editor={editor} className="mt-2" />
        </div>
      </div>
    </div>
  )
}

/** The TipTap editor a ProseMirror view belongs to (TipTap sets `view.dom.editor`). */
function editorFromView(view: { dom: Element }): Editor | undefined {
  return (view.dom as Element & { editor?: Editor }).editor
}

const STATUS_TEXT: Record<Exclude<SaveStatus, 'conflict'>, string> = {
  saved: 'Saved',
  pending: 'Saving…',
  saving: 'Saving…',
  error: 'Error saving',
}

function SaveIndicator({ status, uploading }: { status: SaveStatus; uploading: boolean }) {
  const text = uploading ? 'Uploading image…' : status === 'conflict' ? 'Not saved' : STATUS_TEXT[status]
  const bad = status === 'error' || status === 'conflict'
  return (
    <span
      role="status"
      aria-label="Save status"
      className={`mt-2 shrink-0 text-xs ${bad ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {text}
    </span>
  )
}

interface TitleFieldProps {
  noteId: string
  /** The title the note was loaded with (used until the tree knows it). */
  loadedTitle: string
  onEnter: () => void
}

/**
 * The note title. It is saved through the rename endpoint (`PATCH /api/notes/:id {title}`), never by
 * autosave, on Enter, blur, or when the note is closed. It shows the title from the tree, so a rename
 * from the sidebar appears here too.
 */
function TitleField({ noteId, loadedTitle, onEnter }: TitleFieldProps) {
  const tree = useTree()
  const renameNote = useRenameNote()
  const title = tree.data?.notes.find((n) => n.id === noteId)?.title ?? loadedTitle
  // what the user is typing; null = not editing (show the saved title)
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft !== null && draft !== title) renameNote.mutate({ id: noteId, title: draft })
    setDraft(null)
  }

  // closing the note while the title is being edited still saves it
  const pending = useRef<{ draft: string | null; title: string }>({ draft, title })
  useEffect(() => {
    pending.current = { draft, title }
  })
  const rename = renameNote.mutate
  useEffect(
    () => () => {
      const { draft: d, title: t } = pending.current
      if (d !== null && d !== t) rename({ id: noteId, title: d })
    },
    [noteId, rename],
  )

  return (
    <input
      aria-label="Note title"
      placeholder="Untitled"
      maxLength={500}
      value={draft ?? title}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
          onEnter()
        } else if (event.key === 'Escape') {
          setDraft(null)
        }
      }}
      className="min-w-0 flex-1 bg-transparent text-2xl font-semibold outline-none placeholder:text-muted-foreground/60"
    />
  )
}

/** Shown after a 409: the note changed elsewhere. Offers to copy the local version, then reload. */
function ConflictPrompt({ editor, onReload }: { editor: Editor; onReload: () => Promise<void> }) {
  const [reloading, setReloading] = useState(false)

  const copy = async () => {
    try {
      await copyToClipboard(editor.getHTML(), editor.getText())
      toast.success('Your version was copied to the clipboard')
    } catch {
      toast.error('Could not copy to the clipboard')
    }
  }

  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm">
      <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1">
        This note was changed somewhere else, so your latest edits were not saved. Copy your version before
        reloading if you want to keep it.
      </p>
      <Button variant="outline" size="sm" onClick={copy}>
        Copy my version
      </Button>
      <Button
        size="sm"
        disabled={reloading}
        onClick={async () => {
          setReloading(true)
          try {
            await onReload()
          } finally {
            setReloading(false)
          }
        }}
      >
        Reload note
      </Button>
    </div>
  )
}

/** Copies rich HTML (keeping `attachment://` images, so pasting back restores them) plus plain text. */
async function copyToClipboard(html: string, text: string): Promise<void> {
  const clipboard = navigator.clipboard
  if (typeof ClipboardItem !== 'undefined' && typeof clipboard?.write === 'function') {
    await clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
    return
  }
  await clipboard.writeText(text)
}
