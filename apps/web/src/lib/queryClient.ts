import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { meQueryKey } from '@/features/auth/api'
import { ApiError, isUnauthorized } from './api'

/**
 * The app's QueryClient. Any query or mutation failing with a session 401 clears the cached
 * current user, which makes `RequireAuth` redirect to `/login`.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (err) => handleUnauthorized(err) }),
    mutationCache: new MutationCache({ onError: (err) => handleUnauthorized(err) }),
    defaultOptions: {
      queries: {
        // client errors (4xx) are final; only network/server errors are retried
        retry: (failureCount, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500) && failureCount < 2,
        refetchOnWindowFocus: false,
      },
    },
  })

  function handleUnauthorized(err: unknown): void {
    if (isUnauthorized(err)) client.setQueryData(meQueryKey, null)
  }

  return client
}
