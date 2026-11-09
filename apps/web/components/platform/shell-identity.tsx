"use client"

import { createContext, useContext, type ReactNode } from "react"

import { useApiConfigured, useApiSession } from "@/components/platform/api-session-store"
import { actorNameOf } from "@/lib/data/account-profile"
import { OPERATOR_IDENTITY, type FixtureIdentity } from "@/lib/data/fixture-identity"

// Who is signed in to the shell a page sits in: what the top bar's account
// menu shows, and the one name every record made, changed or deleted there
// stamps as its actor (`useActorName`). The office's shell is the default; a
// restricted shell (the citizen portal, a service provider's workspace)
// provides its own around its pages.
export type ShellIdentity = {
  /** Shown in fixture mode; on the Pilot the account is `/me`'s. */
  fixture: FixtureIdentity
  /** Whether the menu links to Settings › Account & appearance. */
  offersSettings: boolean
}

const OFFICE_SHELL: ShellIdentity = { fixture: OPERATOR_IDENTITY, offersSettings: true }

const ShellIdentityContext = createContext<ShellIdentity>(OFFICE_SHELL)

export function ShellIdentityProvider({ identity, children }: { identity: ShellIdentity; children: ReactNode }) {
  return <ShellIdentityContext.Provider value={identity}>{children}</ShellIdentityContext.Provider>
}

export function useShellIdentity(): ShellIdentity {
  return useContext(ShellIdentityContext)
}

/** Who acts in the shell a page sits in (`actorNameOf`): the account `/me` names on the Pilot, the shell's persona in fixture mode. */
export function useActorName(): string {
  const configured = useApiConfigured()
  const { me, session } = useApiSession()
  const { fixture } = useShellIdentity()
  return actorNameOf(configured, me, session?.email, fixture)
}
