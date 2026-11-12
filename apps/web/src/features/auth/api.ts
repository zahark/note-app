import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { flushAllSaves } from '@/features/editor/api'
import { api, ApiError, isUnauthorized } from '@/lib/api'

export interface User {
  id: string
  email: string
  isOwner: boolean
}

export interface Credentials {
  email: string
  password: string
}

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}

export const meQueryKey = ['auth', 'me'] as const

/** Current user, or `null` when there is no valid session. */
export async function fetchMe(): Promise<User | null> {
  try {
    const { user } = await api.get<{ user: User }>('/api/auth/me')
    return user
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: fetchMe, staleTime: Infinity })
}

/** Drops every cached query except the current user's, so no account ever sees another's data. */
function clearAccountData(client: QueryClient): void {
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== meQueryKey[0] })
}

function useAuthMutation(path: '/api/auth/login' | '/api/auth/signup') {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: Credentials) => api.post<{ user: User }>(path, input),
    onSuccess: ({ user }) => {
      // a fresh session must never see another account's cached data
      clearAccountData(client)
      client.setQueryData(meQueryKey, user)
    },
  })
}

/**
 * Whether the server accepts new accounts right now (by default only until the owner's account exists).
 * Its key is outside `auth`, so signing in or out drops it and the login page asks again.
 */
export function useSignupStatus() {
  return useQuery({
    queryKey: ['signup-status'],
    queryFn: () => api.get<{ open: boolean }>('/api/auth/signup-status'),
  })
}

export const useLogin = () => useAuthMutation('/api/auth/login')
export const useSignup = () => useAuthMutation('/api/auth/signup')

export function useLogout() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      // the open note's last edits must reach the server while the session still exists
      await flushAllSaves()
      return api.post<void>('/api/auth/logout')
    },
    onSuccess: signOutLocally,
    onError: (err) => {
      // the session is already gone on the server, so the browser is signed out either way
      if (isUnauthorized(err)) return signOutLocally()
      // otherwise the session cookie and row may still be valid: stay signed in so the user can retry
      // rather than believing they are signed out on a shared computer
      toast.error('Could not sign out, try again')
    },
  })

  function signOutLocally() {
    clearAccountData(client)
    client.setQueryData(meQueryKey, null)
  }
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => api.post<void>('/api/auth/change-password', input),
  })
}
