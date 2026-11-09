"use client"

import { createContext, useContext, type ReactNode } from "react"

import { OPERATOR_IDENTITY, type FixtureIdentity } from "@/lib/data/fixture-identity"

// What the top bar's account menu shows for the shell a page sits in.
// The office's shell is the default; a restricted shell (the citizen portal,
// a service provider's workspace) provides its own around its pages.
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
