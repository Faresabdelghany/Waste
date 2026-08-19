"use client"

// PROTOTYPE — Products & Prices redesign (throwaway): "Prices" tab on the
// contractor details page. Renders the prototype's PAY lane (spec §4.3)
// filtered to this contractor — locked bid, indexed current fee, Apply index.
// In-memory fixture data only; nothing touches the business-record store.
// Delete together with the rest of this folder.

import { useState } from "react"

import { applyIndexToDb, makeFixtureDb, type PrototypeDb } from "./prototype-data"
import { ContractorPricesLane, type PrototypeActions } from "./prototype-shared"

export function ContractorPricesTab({ contractorName }: { contractorName: string }) {
  const [db, setDb] = useState<PrototypeDb>(makeFixtureDb)

  // Fixture names differ slightly between the registry ("NordRen ApS") and the
  // prototype data ("NordRen A/S") — match on the first word of the name.
  const token = (contractorName.trim().split(/\s+/)[0] ?? contractorName).toLowerCase()
  const rates = db.contractorPrices.filter((rate) =>
    rate.contractor.toLowerCase().startsWith(token),
  )

  const applyIndex: PrototypeActions["applyIndex"] = (rateIds, opts) =>
    setDb((previous) => applyIndexToDb(previous, rateIds, opts))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-4 py-4 sm:px-5">
        <ContractorPricesLane db={db} rates={rates} onApplyIndex={applyIndex} />
      </div>
    </div>
  )
}
