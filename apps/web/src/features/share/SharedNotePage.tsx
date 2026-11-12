import { useParams } from 'react-router'

/**
 * Public shared-note view. Reachable without a session; never uses the owner API.
 * The lock screen, signed-link flow and read-only editor are added with the share feature.
 */
export function SharedNotePage() {
  const { id } = useParams()
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl items-center justify-center p-4" data-shared-id={id}>
      <p className="text-sm text-muted-foreground">Loading shared note…</p>
    </main>
  )
}
