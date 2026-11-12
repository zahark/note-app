import { LogOutIcon, SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useLogout, useMe } from './api'
import { ChangePasswordForm } from './ChangePasswordForm'

/** Account settings: change password and sign out. */
export function SettingsDialog() {
  const me = useMe()
  const logout = useLogout()

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start">
          <SettingsIcon />
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Signed in as {me.data?.email}</DialogDescription>
        </DialogHeader>
        <ChangePasswordForm />
        <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
          <LogOutIcon />
          Sign out
        </Button>
      </DialogContent>
    </Dialog>
  )
}
