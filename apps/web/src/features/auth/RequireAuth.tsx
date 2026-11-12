import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/api'
import { useMe } from './api'

/** Renders `children` only with a valid session; otherwise redirects to `/login` (remembering the page). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe()
  const location = useLocation()

  if (me.isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground" aria-busy="true">
        Loading…
      </div>
    )
  }
  if (me.isError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-4 text-sm">
        <p role="alert">{errorMessage(me.error)}</p>
        <Button variant="outline" onClick={() => void me.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  if (!me.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  return children
}
