"use client"

import Image from "next/image"
import { useRouter } from "next/navigation"
import { useEffect, useState, type FormEvent } from "react"
import { ArrowRight } from "lucide-react"

import { useApiSession } from "@/components/waste/api-session-store"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SignInRefused } from "@/lib/api/auth"
import { afterSignIn, carriesNext, SIGN_IN_PATH } from "@/lib/api/landing"
import { isAccountRefusal, isApiProblem, problemSentence } from "@/lib/api/problem"
import { DEMO_ACCOUNTS } from "@/lib/data/demo-accounts"

/**
 * Where a password sign-in lands in fixture mode, which has no `/me` to ask:
 * the first demo account's home, the operations workspace.
 */
const FIXTURE_SIGNED_IN_HOME = DEMO_ACCOUNTS[0].homePath

// Two faces. With the adapter on — the Pilot (Issue #150) — the password form
// is all there is: the person lands where `/me` says (a driver on the
// driver's app, everyone else on operations) or back on the page the gate
// sent them from (`?next=`), and a session the account's refusal ended is
// explained here in the words of whoever refused it. With the adapter off,
// the account picker stays as it was: a demo account signs in without a
// password and every module reads its fixtures, and a password form beside
// it signs a real account in when a Supabase project is configured
// (lib/api/config.ts; Issue #81).
export function LoginView() {
  const router = useRouter()
  const { session, hydrated, ended, apiConfigured, passwordSignInAvailable, signIn, signOut, loadMe } = useApiSession()
  const [landing, setLanding] = useState(false)
  const [landingError, setLandingError] = useState("")

  // A session that ends here — refused right after sign-in, or signed out on
  // the card — carries no `next` (lib/api/landing.ts): the next person to
  // sign in on this screen lands by their own `/me`.
  useEffect(() => {
    if (session !== null || carriesNext(ended)) return
    if (new URLSearchParams(window.location.search).has("next")) router.replace(SIGN_IN_PATH)
  }, [session, ended, router])

  /** After sign-in, and on Continue. */
  const land = async () => {
    if (!apiConfigured) {
      router.push(FIXTURE_SIGNED_IN_HOME)
      return
    }
    setLanding(true)
    setLandingError("")
    try {
      const me = await loadMe()
      router.replace(afterSignIn(me, new URLSearchParams(window.location.search).get("next")))
    } catch (caught) {
      // An account refusal has ended the session, and `ended` says why below;
      // anything else is said on the card, and Continue asks again.
      if (!(isApiProblem(caught) && isAccountRefusal(caught.problem))) {
        setLandingError(isApiProblem(caught) ? problemSentence(caught.problem) : "Waste could not read your account")
      }
    } finally {
      setLanding(false)
    }
  }

  const refusal = session === null && ended?.reason === "refused" ? ended.detail : null

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
              {apiConfigured
                ? "Sign in with your e-mail address and password."
                : passwordSignInAvailable
                  ? "Sign in with your account, or choose a demo account."
                  : "Choose an account to continue."}
            </p>
          </div>

          {refusal !== null && (
            <p role="alert" className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {refusal}
            </p>
          )}

          {apiConfigured && !passwordSignInAvailable && (
            <p role="alert" className="mt-6 text-sm text-destructive">
              Password sign-in is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
            </p>
          )}

          {passwordSignInAvailable && (
            <div className="mt-6">
              {hydrated && session !== null ? (
                <SignedIn email={session.email} busy={landing} error={landingError} onContinue={() => void land()} onSignOut={() => void signOut()} />
              ) : (
                <PasswordSignIn onSignIn={signIn} onSignedIn={land} />
              )}
            </div>
          )}

          {!apiConfigured && (
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
          )}
        </div>

        <div className="border-t border-border/70 bg-muted/40 px-6 py-4 text-center text-xs text-muted-foreground">
          {apiConfigured
            ? "Signing in with a temporary password? Change it from the account menu once you are in."
            : "Demo environment — accounts sign in without a password."}
        </div>
      </div>
    </main>
  )
}

function PasswordSignIn({ onSignIn, onSignedIn }: { onSignIn: (email: string, password: string) => Promise<unknown>; onSignedIn: () => Promise<void> }) {
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
    } catch (caught) {
      setError(caught instanceof SignInRefused ? caught.message : "Sign-in failed")
      setBusy(false)
      return
    }
    await onSignedIn()
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

function SignedIn({ email, busy, error, onContinue, onSignOut }: { email: string | null; busy: boolean; error: string; onContinue: () => void; onSignOut: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/10 p-4">
      <p className="text-sm">Signed in{email ? ` as ${email}` : ""}.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" className="flex-1" onClick={onContinue} disabled={busy}>
          {busy ? "Opening Waste…" : "Continue"}
        </Button>
        <Button type="button" variant="outline" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  )
}
