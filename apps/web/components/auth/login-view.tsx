"use client"

import Image from "next/image"
import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"
import { ArrowRight } from "lucide-react"

import { useApiSession } from "@/components/waste/api-session-store"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SignInRefused } from "@/lib/api/auth"
import { DEMO_ACCOUNTS } from "@/lib/data/demo-accounts"

/** Where a signed-in person lands: the operations workspace, as the first demo account does. */
const SIGNED_IN_HOME = "/performance"

// The account picker stays as it was: a demo account signs in without a
// password and every module reads its fixtures. Beside it, when the web is
// configured against a Supabase project (lib/api/config.ts), a password form
// signs a real account in through Supabase Auth (Issue #81); the session it
// gets is what the record store calls the API with, so the switched modules
// read the server for that person and every other module stays on fixtures.
export function LoginView() {
  const router = useRouter()
  const { session, hydrated, apiConfigured, passwordSignInAvailable, signIn, signOut } = useApiSession()

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
        <div className="px-6 pt-8 pb-6">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Image src="/logo-wrapper.png" alt="Waste" width={24} height={24} />
            </div>
            <h1 className="mt-2 text-xl font-semibold">Sign in to Waste</h1>
            <p className="text-sm text-muted-foreground">
              {passwordSignInAvailable ? "Sign in with your account, or choose a demo account." : "Choose an account to continue."}
            </p>
          </div>

          {passwordSignInAvailable && (
            <div className="mt-6">
              {hydrated && session !== null ? (
                <SignedIn email={session.email} onContinue={() => router.push(SIGNED_IN_HOME)} onSignOut={signOut} />
              ) : (
                <PasswordSignIn onSignIn={signIn} onSignedIn={() => router.push(SIGNED_IN_HOME)} />
              )}
            </div>
          )}

          <div className="mt-6 space-y-2">
            {passwordSignInAvailable && (
              <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Demo accounts</p>
            )}
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.id}
                type="button"
                className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted/20 p-3 text-left transition-colors hover:bg-muted/60"
                onClick={() => router.push(account.homePath)}
              >
                <Avatar className="h-9 w-9">
                  {account.avatarSrc && <AvatarImage src={account.avatarSrc} />}
                  <AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                    {account.initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{account.detail}</p>
                  <p className="truncate text-xs text-muted-foreground/70">{account.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-muted-foreground/80">{account.viewLabel}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-border/70 bg-muted/40 px-6 py-4 text-center text-xs text-muted-foreground">
          {apiConfigured
            ? "Demo accounts sign in without a password and read fixture data; a signed-in account reads Company & Projects, Users & Roles, Service Providers and Contacts from the API."
            : "Demo environment — accounts sign in without a password."}
        </div>
      </div>
    </main>
  )
}

function PasswordSignIn({ onSignIn, onSignedIn }: { onSignIn: (email: string, password: string) => Promise<unknown>; onSignedIn: () => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await onSignIn(email, password)
      onSignedIn()
    } catch (caught) {
      setError(caught instanceof SignInRefused ? caught.message : "Sign-in failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-muted/10 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="login-email">E-mail</Label>
        <Input
          id="login-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="login-password">Password</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}

function SignedIn({ email, onContinue, onSignOut }: { email: string | null; onContinue: () => void; onSignOut: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/10 p-4">
      <p className="text-sm">Signed in{email ? ` as ${email}` : ""}.</p>
      <div className="flex gap-2">
        <Button type="button" className="flex-1" onClick={onContinue}>
          Continue
        </Button>
        <Button type="button" variant="outline" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  )
}
