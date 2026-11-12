import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'

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

function useAuthMutation(path: '/api/auth/login' | '/api/auth/signup') {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: Credentials) => api.post<{ user: User }>(path, input),
    onSuccess: ({ user }) => {
      // a fresh session must never see another account's cached data
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== meQueryKey[0] })
      client.setQueryData(meQueryKey, user)
    },
  })
}

export const useLogin = () => useAuthMutation('/api/auth/login')
export const useSignup = () => useAuthMutation('/api/auth/signup')

export function useLogout() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSettled: () => {
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== meQueryKey[0] })
      client.setQueryData(meQueryKey, null)
    },
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => api.post<void>('/api/auth/change-password', input),
  })
}
