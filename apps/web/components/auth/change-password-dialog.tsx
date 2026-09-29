"use client"

// Change password (Issue #150), from the sidebar's account menu on the Pilot:
// a tester replaces the temporary password the Supabase organisation's Owner
// handed over. The current password is verified by Auth before the new one
// is set (lib/api/auth.ts, `updatePassword`), and Auth judges the new one —
// at least `minimum_password_length` characters (supabase/config.toml), not
// the same as the old — in its own words. The confirmation is this form's
// alone, so a typo never reaches Auth.
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useApiSession } from "@/components/waste/api-session-store"
import { PasswordChangeRefused } from "@/lib/api/auth"

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session, me, updatePassword } = useApiSession()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const close = () => {
    setCurrentPassword("")
    setNewPassword("")
    setConfirmation("")
    setError("")
    onOpenChange(false)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    if (newPassword !== confirmation) {
      setError("The new password and its confirmation are not the same")
      return
    }
    setBusy(true)
    setError("")
    try {
      await updatePassword(currentPassword, newPassword)
      toast.success("Password changed")
      close()
    } catch (caught) {
      setError(caught instanceof PasswordChangeRefused ? caught.message : "The password could not be changed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While a change is in flight the dialog stays open, so its answer lands in the form that asked.
        if (next) onOpenChange(true)
        else if (!busy) close()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Enter the password you signed in with, then the one you will use from now on.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {/* The account the password belongs to, for the browser's password manager. */}
          <input type="email" autoComplete="username" value={me?.user.email ?? session?.email ?? ""} readOnly hidden />
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input id="confirm-password" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Changing…" : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
