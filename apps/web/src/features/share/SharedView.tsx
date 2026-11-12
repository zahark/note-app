import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { EditorContent, useEditor } from '@tiptap/react'
import { useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { editorExtensions, toEditorContent } from '@/features/editor/extensions'
import { displayTitle } from '@/features/tree/buildTree'
import { isUnreachable } from '@/lib/api'
import { createSharedAttachmentResolver, fetchSharedNote, type SharedCredential, type SharedNote } from './api'
import { LockScreen } from './LockScreen'

/**
 * The public page for a shared note (`/shared/:id`). It never uses the owner API or the session.
 *
 * - A signed link carries `?exp=&sig=`; the note is loaded with them straight away.
 * - Otherwise it is a PIN share: the lock screen exchanges the PIN for a read token, which is kept in
 *   this component's state only (never in a URL or browser storage), so a reload asks for the PIN again.
 *
 * The note is shown read-only, without the sidebar or any editor chrome. Every failure (wrong link,
 * expired, revoked, missing) shows the same "unavailable" page.
 */
export function SharedView() {
  const { id = '' } = useParams()
  const [searchParams] = useSearchParams()
  const exp = searchParams.get('exp')
  const sig = searchParams.get('sig')
  const [token, setToken] = useState<string | null>(null)

  const credential = useMemo<SharedCredential | null>(() => {
    if (exp !== null || sig !== null) return { kind: 'signed', exp: exp ?? '', sig: sig ?? '' }
    return token !== null ? { kind: 'token', token } : null
  }, [exp, sig, token])

  if (!credential) return <LockScreen noteId={id} onUnlock={setToken} />
  return <SharedNoteLoader noteId={id} credential={credential} />
}

function SharedNoteLoader({ noteId, credential }: { noteId: string; credential: SharedCredential }) {
  const note = useQuery({
    // the credential itself stays out of the key; it never changes while this component is mounted
    queryKey: ['shared-note', noteId, credential.kind],
    queryFn: ({ signal }) => fetchSharedNote(noteId, credential, signal),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnReconnect: false,
  })

  if (note.isPending) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <div role="status" aria-label="Loading shared note" className="space-y-4">
          <div className="h-8 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        </div>
      </main>
    )
  }
  if (note.isError) {
    if (isUnreachable(note.error)) {
      return (
        <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-4 text-center text-sm">
          <p className="text-muted-foreground">Could not load this note. Check your connection and try again.</p>
          <Button variant="outline" size="sm" onClick={() => note.refetch()}>
            Retry
          </Button>
        </main>
      )
    }
    return <SharedUnavailable />
  }
  return <SharedNoteContent noteId={noteId} credential={credential} note={note.data} />
}

/** The one page shown for every unavailable share, whatever the reason. */
function SharedUnavailable() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-4 text-center" data-testid="shared-unavailable">
      <h1 className="text-lg font-semibold">This shared note is unavailable</h1>
      <p className="text-sm text-muted-foreground">The link may be wrong, or it has expired or been turned off.</p>
    </main>
  )
}

interface SharedNoteContentProps {
  noteId: string
  credential: SharedCredential
  note: SharedNote
}

/**
 * Read-only TipTap with the shared schema. Images and files are fetched with the credential and shown
 * as blob URLs (the PDF viewer reads its bytes from one); a file's Download saves that blob.
 */
function SharedNoteContent({ noteId, credential, note }: SharedNoteContentProps) {
  const [resolver] = useState(() => createSharedAttachmentResolver(noteId, credential))
  useEffect(() => () => resolver.dispose(), [resolver])

  const editor = useEditor({
    editable: false,
    extensions: editorExtensions({
      resolveAttachment: resolver.resolve,
      downloadAttachment: (aid, name) => {
        resolver.download(aid, name).catch(() => toast.error(`Could not download ${name}. Try again in a moment.`))
      },
    }),
    content: toEditorContent(note.content),
    editorProps: { attributes: { class: 'note-content', 'aria-label': 'Shared note content' } },
  })

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <p className="mb-2 text-xs tracking-wide text-muted-foreground uppercase">Shared note · read-only</p>
      <h1 className="mb-4 text-2xl font-semibold break-words">{displayTitle(note.title)}</h1>
      <EditorContent editor={editor} />
    </main>
  )
}
