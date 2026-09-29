"use client"

// The sign-in gate (Issue #150), in the root layout around every page. With
// the adapter off it is not there at all: fixture mode, local development and
// e2e render exactly as before. With it on — the Pilot — no page but /login
// renders without a session: nothing is drawn until the browser's session has
// been read, so fixture data never flashes, and a visitor without one is sent
// to /login, carrying where they were going unless their session ended by a
// sign-out or a refusal (lib/api/landing.ts holds the rules and their tests).
import { usePathname, useRouter } from "next/navigation"
import { Suspense, useEffect, type ReactNode } from "react"

import { useApiConfigured, useApiSession } from "@/components/waste/api-session-store"
import { gateOf, signInTarget } from "@/lib/api/landing"

export function SignInGate({ children }: { children: ReactNode }) {
  if (!useApiConfigured()) return children
  // Suspense above usePathname: under Cache Components a route with an
  // unknown dynamic param cannot resolve its pathname while prerendering.
  return (
    <Suspense fallback={null}>
      <PilotGate>{children}</PilotGate>
    </Suspense>
  )
}

function PilotGate({ children }: { children: ReactNode }) {
  const { hydrated, session, ended } = useApiSession()
  const pathname = usePathname()
  const router = useRouter()
  const gate = gateOf({ configured: true, hydrated, signedIn: session !== null }, pathname)

  useEffect(() => {
    if (gate === "sign-in") router.replace(signInTarget(ended, `${window.location.pathname}${window.location.search}`))
  }, [gate, ended, router])

  return gate === "show" ? children : null
}
