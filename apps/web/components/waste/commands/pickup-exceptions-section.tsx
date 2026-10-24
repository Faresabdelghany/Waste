"use client"
// A place's Pickup Exceptions in its details (M5 of #293): the stops at a
// property or a shared point missed for the customer, or collected and tagged
// with a contaminant code, over the year before the project's today, newest
// first, each with what the charge rules in force say of it now. A stop the
// store holds opens in Route Studio, where its proofs are; one older than the
// stops' window is named by its date alone. The sentences are
// lib/data/pickup-exception-history.ts'.
import Link from "next/link"

import { useServerModuleState } from "@/components/waste/business-record-store"
import { useApiSession } from "@/components/waste/api-session-store"
import { useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import { PICKUPS_MODULE } from "@/lib/api/records/pickups"
import { getBusinessModuleHref } from "@/lib/data/business-links"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import { MASTER_DATA_MODULE } from "@/lib/data/master-data"
import { chargeSentence, exceptionSentence, historyReadable, historySummary, placePickupExceptions, type ExceptionPlace } from "@/lib/data/pickup-exception-history"

const READS: Readonly<Record<ExceptionPlace, ReturnType<typeof placePickupExceptions>>> = {
  property: placePickupExceptions("property"),
  "shared-point": placePickupExceptions("shared-point"),
}

export function PickupExceptionsSection({ record, module, place }: { record: BusinessRecord; module: ModuleLocation; place: ExceptionPlace }) {
  const { me } = useApiSession()
  const readable = historyReadable(me?.role.grants, place)
  const history = useRowHistory(module.workspaceId, module.moduleId, record, readable ? "read" : "not-granted", readable ? READS[place] : NO_HISTORY)
  const productName = useServerNames(PRODUCTS_MODULE, "product")
  const codeName = useServerNames(MASTER_DATA_MODULE, "contaminant-code")
  const stops = useServerModuleState(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId)
  const stopOf = (serverId: string) => [...(stops?.serverIds ?? [])].find(([, id]) => id === serverId)?.[0] ?? null
  const read = history.rows?.[0] ?? null

  return (
    <section className="space-y-2" data-testid="pickup-exceptions" aria-label="Pickup exceptions">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pickup exceptions</h3>
      {!readable ? (
        <p className="text-sm text-muted-foreground">The pickup exceptions are not shown to your role.</p>
      ) : history.problem !== null ? (
        <p className="text-sm text-muted-foreground">The pickup exceptions could not be read from the API: {history.problem}</p>
      ) : read === null ? (
        <p className="text-sm text-muted-foreground">Reading the pickup exceptions from the API…</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{historySummary(read)}</p>
          {read.items.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {read.items.map((item) => {
                const stop = stopOf(item.pickupId)
                return (
                  <li key={item.pickupId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="tabular-nums text-muted-foreground">{item.serviceDate}</span> · <span className="font-medium">{exceptionSentence(item, codeName)}</span>
                    </span>
                    <span className="flex items-baseline gap-3">
                      <span className="text-muted-foreground">{chargeSentence(item, productName)}</span>
                      {stop !== null && (
                        <Link className="text-xs underline underline-offset-2" href={getBusinessModuleHref(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, stop)}>
                          Open stop
                        </Link>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

const NO_HISTORY = async () => []
