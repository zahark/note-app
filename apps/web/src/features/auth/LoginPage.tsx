import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLogin, useMe, useSignup } from './api'
import { FormField } from './FormField'
import { errorMessage, validateEmail, validatePassword } from './validation'

type Mode = 'login' | 'signup'

interface FieldErrors {
  email?: string | null
  password?: string | null
  confirm?: string | null
}

/** Where to go after authenticating: the protected page that redirected here, or home. */
function useRedirectTarget(): string {
  const location = useLocation()
  const from = (location.state as { from?: unknown } | null)?.from
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/'
}

export function LoginPage() {
  const me = useMe()
  const navigate = useNavigate()
  const target = useRedirectTarget()
  const login = useLogin()
  const signup = useSignup()

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  const mutation = mode === 'login' ? login : signup

  if (me.data) return <Navigate to={target} replace />

  function switchMode(next: Mode) {
    setMode(next)
    setErrors({})
    setConfirm('')
    login.reset()
    signup.reset()
  }

  function validate(): FieldErrors | null {
    const next: FieldErrors =
      mode === 'login'
        ? { email: validateEmail(email), password: password ? null : 'Password is required' }
        : {
            email: validateEmail(email),
            password: validatePassword(password),
            confirm: confirm === password ? null : 'Passwords do not match',
          }
    return Object.values(next).some(Boolean) ? next : null
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const invalid = validate()
    setErrors(invalid ?? {})
    if (invalid || mutation.isPending) return
    mutation.mutate(
      { email: email.trim(), password },
      { onSuccess: () => navigate(target, { replace: true }) },
    )
  }

  const isLogin = mode === 'login'
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">{isLogin ? 'Sign in' : 'Create account'}</h1>
          </CardTitle>
          <CardDescription>
            {isLogin ? 'Sign in to your notes.' : 'Create the account that will own your notes.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={onSubmit} noValidate>
            <FormField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
            />
            <FormField
              label="Password"
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
            />
            {!isLogin && (
              <FormField
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                error={errors.confirm}
              />
            )}
            {mutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(mutation.error)}
              </p>
            )}
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {isLogin ? 'No account yet? ' : 'Already have an account? '}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => switchMode(isLogin ? 'signup' : 'login')}
            >
              {isLogin ? 'Create one' : 'Sign in'}
            </Button>
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
