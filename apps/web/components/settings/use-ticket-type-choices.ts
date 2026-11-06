"use client"

// The company's ticket types as the settings by type list them (#548 of
// #544): the SLA's targets, the default teams and the ticket charges each
// take a row per type beside the kinds. Read straight from `/ticket-types`,
// under the templates' grant or the tickets', by server id; a role that reads
// neither lists no type, and a setting naming one says so (`unknownTypeName`).
import type { TicketType } from "@waste/contracts/ticket-types"
import { useReport } from "@/components/insight/use-report"
import { listAll } from "@/lib/api/client"
import type { TypeChoice } from "@/lib/data/ticket-scope"

/** The company's ticket types, every status and each kind's default marked, by name; null until read, none where the role reads none. */
export function useTicketTypeChoices(): readonly TypeChoice[] | null {
  const read = useReport<TypeChoice[]>("ticket-type-choices", async (client) =>
    (await listAll<TicketType>(client, "/ticket-types").catch(() => []))
      .map(({ id, name, kind, status, isDefault }) => ({ id, name, kind, status, isDefault }))
      .sort((one, other) => one.name.localeCompare(other.name)),
  )
  return read.report
}
