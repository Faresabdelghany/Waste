"use client"

import { useShellIdentity } from "@/components/platform/shell-identity"
import { useApiSession } from "@/components/platform/api-session-store"
import { accountGrants, type Grants } from "@/lib/modules/grants"

/**
 * The grants the account signed in works under, the office's and a
 * provider's alike: `/me`'s on the Pilot, and in fixture mode the role of
 * the persona the shell is signed in as (`useShellIdentity`). Null where
 * nothing holds the account back (`accountGrants`).
 */
export function useGrants(): Grants | null {
  const { apiConfigured, me } = useApiSession()
  const { fixture } = useShellIdentity()
  return accountGrants({ apiConfigured, me, fixtureRole: fixture.role })
}
