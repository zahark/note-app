import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { meQueryKey } from '@/features/auth/api'
import { ApiError, isUnauthorized } from './api'

/**
 * When `err` means the session is gone (401 `UNAUTHORIZED`), clears the cached current user, which makes
 * `RequireAuth` redirect to `/login`. For failures outside a query or mutation (e.g. autosave).
 */
export function handleUnauthorized(client: QueryClient, err: unknown): void {
  if (isUnauthorized(err)) client.setQueryData(meQueryKey, null)
}

/**
 * The app's QueryClient. Any query or mutation failing with a session 401 clears the cached
 * current user (`handleUnauthorized`).
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (err) => handleUnauthorized(client, err) }),
    mutationCache: new MutationCache({ onError: (err) => handleUnauthorized(client, err) }),
    defaultOptions: {
      queries: {
        // client errors (4xx) are final; only network/server errors are retried
        retry: (failureCount, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500) && failureCount < 2,
        refetchOnWindowFocus: false,
      },
    },
  })
  return client
}
