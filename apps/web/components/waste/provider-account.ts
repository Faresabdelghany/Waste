"use client"
// Who the provider's workspace belongs to on the Pilot (#291 C24): the
// provider `/me` names, its row's web id — the handle the workspace scopes
// its records and stamps its writes by — and what a surface offers the
// account signed in (`commandOffered`): the office every command, as before;
// a provider's account the ones the API gives a provider, where its role
// allows them. Null while the adapter is off, before `/me` has answered, and
// for an office account.
import { webIdVia } from "@/lib/api/records/references"
import type { ModuleLocation } from "@/lib/data/business-modules"
import { commandOffered, providerWorkspaceOf, type ProviderWorkspace } from "@/lib/data/provider-workspace"

import { useApiSession } from "./api-session-store"
import { useServerResolver } from "./business-record-store"

/** What `/me` says of the provider's workspace: null in fixture mode, before `/me` answers, and for an office account. */
export function useProviderWorkspace(): ProviderWorkspace | null {
  const { apiConfigured, me } = useApiSession()
  return apiConfigured && me !== null ? providerWorkspaceOf(me) : null
}

/** Whether the account signed in is a Service Provider's: what a surface reads for what is the provider's alone (its comment thread). */
export function useIsProviderAccount(): boolean {
  return useProviderWorkspace() !== null
}

/** Whether a surface offers each command of a module to the account signed in (`commandOffered`): every one for the office. */
export function useCommandOffered(module: ModuleLocation): (command: string) => boolean {
  const { apiConfigured, me } = useApiSession()
  const provider = apiConfigured && me !== null && me.serviceProvider !== null
  const key = `${module.workspaceId}.${module.moduleId}`
  return (command) => commandOffered({ provider, grants: me?.role.grants }, key, command)
}

/** A provider's web id, by its server id, through the resolver: the providers module's handle once read, its chip before. */
export function useProviderWebId(providerId: string | undefined): string | undefined {
  const resolve = useServerResolver()
  return providerId === undefined ? undefined : webIdVia({ fixtures: [], resolve }, "service-provider", providerId)
}
