// Settings › Integrations on the Pilot (#487): each service the deployment
// calls as a person reads it — what it is, which way data goes, and its
// state in a sentence — from `GET /integrations`, the routing quota and the
// latest CSV import. Pure; the pane reads it. A connection the deployment
// does not make is said so, never shown as a vendor it might have: the
// fixtures' Webfleet, Navision and Digital Post are not this deployment's.
import type { ImportRun } from "@waste/contracts/imports"
import type { Integrations } from "@waste/contracts/integrations"
import type { RoutingQuota } from "@waste/contracts/routing-quota"

import { OPENROUTESERVICE, quotaBanner } from "@/lib/routing/readings"

export type IntegrationTone = "healthy" | "warning" | "danger" | "neutral"

/** One connection as the pane lists it. */
export type IntegrationRow = { id: string; name: string; direction: string; description: string; state: string; tone: IntegrationTone }

/** The register the API knows by name, as a person reads it. */
const REGISTERS: Record<string, string> = { dataforsyningen: "Danish Address Register (DAR) · Dataforsyningen", fake: "Test address register" }

function routingRow(integrations: Integrations, quota: RoutingQuota | null, now: Date): IntegrationRow {
  const provider = integrations.routing.provider
  const base = { id: "routing", direction: "Outbound", description: "Road distances, durations and optimised stop orders for routes and the guided setup." }
  if (provider !== OPENROUTESERVICE) {
    return { ...base, name: "Routing · built-in estimate", state: "No provider · straight-line estimates", tone: "neutral" }
  }
  const banner = quotaBanner(quota, now)
  const name = "Routing · openrouteservice"
  if (banner?.tone === "refused") return { ...base, name, state: banner.sentence, tone: "danger" }
  if (banner?.tone === "waiting") return { ...base, name, state: banner.sentence, tone: "warning" }
  return { ...base, name, state: quota === null ? "Connected" : "Connected · quota available", tone: "healthy" }
}

function registerRow(integrations: Integrations): IntegrationRow {
  const base = { id: "address-register", direction: "Inbound", description: "Looks up a property's address, its parts, its BFE number and its point." }
  const register = integrations.addressRegister
  if (register === null) return { ...base, name: "Address register", state: "Not set up · addresses are typed", tone: "neutral" }
  return { ...base, name: REGISTERS[register.provider] ?? `Address register · ${register.provider}`, state: "Connected", tone: register.provider === "fake" ? "neutral" : "healthy" }
}

function storageRow(integrations: Integrations): IntegrationRow {
  const base = { id: "proof-storage", name: "Proof storage · Supabase Storage", direction: "Outbound", description: "Keeps the photos and signatures drivers record at their stops." }
  return integrations.proofStorage.configured
    ? { ...base, state: "Connected", tone: "healthy" }
    : { ...base, state: "Not set up · photos and signatures are refused", tone: "warning" }
}

/** The latest import as one line: its file and how its rows came out; a refusal a warning, a run not yet complete said so. */
export function importRow(latest: ImportRun | null): IntegrationRow {
  const base = { id: "imports", name: "CSV import", direction: "Inbound", description: "Customers, properties, containers and agreements from a file, each row's outcome kept." }
  if (latest === null) return { ...base, state: "No import yet", tone: "neutral" }
  const { created, updated, unchanged, refused } = latest.counts
  const recorded = created + updated + unchanged + refused
  if (recorded < latest.rowCount) return { ...base, state: `${latest.fileName} · ${recorded} of ${latest.rowCount} rows recorded`, tone: "warning" }
  if (refused > 0) return { ...base, state: `${latest.fileName} · ${refused} of ${latest.rowCount} rows refused`, tone: "warning" }
  return { ...base, state: `${latest.fileName} · ${latest.rowCount} rows imported`, tone: "healthy" }
}

/** The deployment's connections in the pane's order: the services it calls, then what comes in by file. */
export function integrationRowsOf({ integrations, quota, now }: { integrations: Integrations; quota: RoutingQuota | null; now: Date }): IntegrationRow[] {
  return [routingRow(integrations, quota, now), registerRow(integrations), storageRow(integrations)]
}
