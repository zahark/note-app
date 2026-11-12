import { useState } from 'react'
import type { Editor } from '@tiptap/react'
import { AlertTriangleIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/** Shown after a 409: the note changed elsewhere. Offers to copy the local version, then reload. */
export function ConflictPrompt({ editor, onReload }: { editor: Editor; onReload: () => Promise<void> }) {
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
