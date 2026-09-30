"use client"

// The Driver App's frame (Issue #145): a phone-width column with none of the
// office's navigation, and the states that stand in front of both screens.
// With the adapter off — no API configured — and with nobody signed in it
// shows sign-in and never a fixture or demo stop (the gate sends a signed-out
// visitor to /login before this renders on the Pilot); a login the door does
// not take shows the door's sentence; a first read that found no server shows
// only the count of what waits and Retry, since there is no display cache to
// show stale stops from. Once the start screen has been read, the last read
// stays on screen and the banner says when the server is out of reach or a
// batch was refused whole — the second beside Discard waiting actions, the
// only way a person empties the queue.
import Link from "next/link"
import { useState, type ReactNode } from "react"
import { ArrowClockwise, CloudSlash, SignOut, Truck, Warning } from "@phosphor-icons/react/dist/ssr"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useApiSession } from "@/components/waste/api-session-store"
import { useDriverApp, useDriverAppState } from "@/components/waste/driver/driver-app-provider"
import { SIGN_IN_PATH } from "@/lib/api/landing"
import { unreachableBanner } from "@/lib/driver/route-view"

export function DriverFrame({ children }: { children: ReactNode }) {
  const { apiConfigured, session, signOut } = useApiSession()
  const state = useDriverAppState()
  const signedIn = apiConfigured && session !== null

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-4">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Truck className="size-6 text-primary" weight="duotone" aria-hidden />
            <div>
              <p className="text-base font-semibold leading-tight">Driver App</p>
              {state.me !== null && <p className="text-sm text-muted-foreground">{state.me.driver.name}</p>}
            </div>
          </div>
          {signedIn && (
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <SignOut aria-hidden />
              Sign out
            </Button>
          )}
        </header>
        {!signedIn ? <SignInPanel apiConfigured={apiConfigured} /> : <SignedIn>{children}</SignedIn>}
      </div>
    </div>
  )
}

function SignedIn({ children }: { children: ReactNode }) {
  const state = useDriverAppState()
  if (state.status === "not-a-driver") {
    return (
      <Alert variant="destructive">
        <Warning aria-hidden />
        <AlertTitle>This login does not drive</AlertTitle>
        <AlertDescription>{state.refusal}</AlertDescription>
      </Alert>
    )
  }
  if (state.status === "unreachable") return <UnreachableScreen />
  if (state.status === "loading") return <p className="py-8 text-center text-sm text-muted-foreground">Loading your routes…</p>
  return (
    <>
      <DriverBanner />
      {children}
    </>
  )
}

function SignInPanel({ apiConfigured }: { apiConfigured: boolean }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <h1 className="text-lg font-semibold">Sign in to drive</h1>
      <p className="text-sm text-muted-foreground">
        {apiConfigured ? "The Driver App shows the routes dispatched to you once you sign in." : "The Driver App works against the Waste API, and this deployment is not connected to one."}
      </p>
      {apiConfigured && (
        <Button asChild className="h-11">
          <Link href={`${SIGN_IN_PATH}?next=${encodeURIComponent("/driver")}`}>Sign in</Link>
        </Button>
      )}
    </section>
  )
}

/** After a load with no server: the count and Retry, and nothing stale. */
function UnreachableScreen() {
  const app = useDriverApp()
  const state = useDriverAppState()
  const [retrying, setRetrying] = useState(false)
  return (
    <section className="flex flex-col items-center gap-3 rounded-xl border p-6 text-center">
      <CloudSlash className="size-8 text-muted-foreground" aria-hidden />
      <p role="status" className="font-medium">
        {unreachableBanner(state.waiting.length)}
      </p>
      <Button
        className="h-11"
        disabled={retrying}
        onClick={() => {
          setRetrying(true)
          void app.retry().finally(() => setRetrying(false))
        }}
      >
        <ArrowClockwise aria-hidden />
        Retry
      </Button>
    </section>
  )
}

function DriverBanner() {
  const app = useDriverApp()
  const state = useDriverAppState()
  const [confirming, setConfirming] = useState(false)
  const count = state.waiting.length
  return (
    <>
      {state.unreachable && (
        <Alert role="status">
          <CloudSlash aria-hidden />
          <AlertTitle>{unreachableBanner(count)}</AlertTitle>
          <AlertDescription>
            <p>Your actions are kept on this phone and sent when the connection returns.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void app.retry()}>
              <ArrowClockwise aria-hidden />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {state.refused !== null && (
        <Alert variant="destructive">
          <Warning aria-hidden />
          <AlertTitle>The server refused {count === 1 ? "the waiting action" : `the ${count} waiting actions`}</AlertTitle>
          <AlertDescription>
            <p>{state.refused}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setConfirming(true)}>
              Discard waiting actions
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard waiting actions?</DialogTitle>
            <DialogDescription>
              {count === 1 ? "The action waiting on this phone" : `The ${count} actions waiting on this phone`} will never reach the server. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Keep them
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                void app.discardWaiting()
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
