"use client"

// The company's ticket types as the settings by type list them (#548 of
// #544): the SLA's targets, the default teams and the ticket charges each
// take a row per type beside the kinds. Read straight from `/ticket-types`,
// under the templates' grant or the tickets', by server id; a role that reads
// neither lists no type, and a setting naming one says so (`unknownTypeName`),
// as it says a read that failed.
import type { TicketType } from "@waste/contracts/ticket-types"
import { useReport } from "@/components/platform/use-report"
import { listAll } from "@/lib/api/client"
import { problemOfError } from "@/lib/api/problem"
import type { TypeChoice, TypeChoices } from "@/lib/data/ticket-scope"

/** The company's ticket types, every status and each kind's default marked, by name: null until read, none where the role reads none (a 403), `failed` where the read did otherwise. */
export function useTicketTypeChoices(): TypeChoices {
  const read = useReport<TypeChoice[]>("ticket-type-choices", async (client) => {
    const types = await listAll<TicketType>(client, "/ticket-types").catch((error: unknown) => {
      if (problemOfError(error).status === 403) return []
      throw error
    })
    return types.map(({ id, name, kind, status, isDefault }) => ({ id, name, kind, status, isDefault })).sort((one, other) => one.name.localeCompare(other.name))
  })
  return read.problem !== null ? "failed" : read.report
}
