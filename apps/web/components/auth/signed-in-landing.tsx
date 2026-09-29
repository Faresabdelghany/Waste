"use client"

// `/` on the Pilot (Issue #150): the signed-in home is where `/me` lands the
// person — a driver on the driver's app, everyone else on operations — so the
// root reads `/me` (refreshing a token that ran out first) and goes there. A
// visitor without a session never gets here: the gate sends them to /login.
// If `/me` cannot be read, /login's signed-in card offers Continue, which
// reads it again and says what went wrong; an account refusal has ended the
// session, and /login says so.
import { useRouter } from "next/navigation"
import { useEffect } from "react"

import { useApiSession } from "@/components/waste/api-session-store"
import { landingOf } from "@/lib/api/landing"
import { whoOf } from "@/lib/api/session"

export function SignedInLanding() {
  const { session, loadMe } = useApiSession()
  const router = useRouter()
  const who = session === null ? null : whoOf(session)

  useEffect(() => {
    if (who === null) return
    let current = true
    loadMe().then(
      (me) => {
        if (current) router.replace(landingOf(me))
      },
      () => {
        if (current) router.replace("/login")
      },
    )
    return () => {
      current = false
    }
  }, [who, loadMe, router])

  return null
}
