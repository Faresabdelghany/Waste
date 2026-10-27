"use client"
// Who the provider's workspace belongs to on the Pilot (#291 C24): the
// provider `/me` names, and its row's web id in the providers module — the
// handle the workspace scopes its records and stamps its writes by. Null
// while the adapter is off, before `/me` has answered, and for an office
// account.
import { webIdOf } from "@/lib/api/records/adapter"
import { SERVICE_PROVIDERS_MODULE } from "@/lib/data/provider-money"
import { providerWorkspaceOf, type ProviderWorkspace } from "@/lib/data/provider-workspace"

import { useApiSession } from "./api-session-store"
import { useServerModuleState } from "./business-record-store"

/** What `/me` says of the provider's workspace: null in fixture mode, before `/me` answers, and for an office account. */
export function useProviderWorkspace(): ProviderWorkspace | null {
  const { apiConfigured, me } = useApiSession()
  return apiConfigured && me !== null ? providerWorkspaceOf(me) : null
}

/** Whether the account signed in is a Service Provider's: what a surface reads to offer only what the API gives a provider. */
export function useIsProviderAccount(): boolean {
  return useProviderWorkspace() !== null
}

/** A provider's web id, by its server id: the providers module's handle once read, its id chip before. */
export function useProviderWebId(providerId: string | undefined): string | undefined {
  const state = useServerModuleState(SERVICE_PROVIDERS_MODULE.workspaceId, SERVICE_PROVIDERS_MODULE.moduleId)
  if (providerId === undefined) return undefined
  for (const [webId, serverId] of state?.serverIds ?? []) if (serverId === providerId) return webId
  return webIdOf("service-provider", providerId)
}
