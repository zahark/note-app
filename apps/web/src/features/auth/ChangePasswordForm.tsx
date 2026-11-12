import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useChangePassword } from './api'
import { FormField } from './FormField'
import { errorMessage, validatePassword } from './validation'

interface FieldErrors {
  currentPassword?: string | null
  newPassword?: string | null
  confirm?: string | null
}

export function ChangePasswordForm() {
  const change = useChangePassword()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const next: FieldErrors = {
      currentPassword: currentPassword ? null : 'Current password is required',
      newPassword: validatePassword(newPassword),
      confirm: confirm === newPassword ? null : 'Passwords do not match',
    }
    const invalid = Object.values(next).some(Boolean)
    setErrors(invalid ? next : {})
    if (invalid || change.isPending) return
    change.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setCurrentPassword('')
          setNewPassword('')
          setConfirm('')
        },
      },
    )
  }

  return (
    <form className="grid gap-4" onSubmit={onSubmit} noValidate aria-label="Change password">
      <FormField
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        error={errors.currentPassword}
      />
      <FormField
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        error={errors.newPassword}
      />
      <FormField
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={errors.confirm}
      />
      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(change.error)}
        </p>
      )}
      {change.isSuccess && (
        <p role="status" className="text-sm text-muted-foreground">
          Password changed. Other sessions have been signed out.
        </p>
      )}
      <Button type="submit" disabled={change.isPending}>
        {change.isPending ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  )
}
