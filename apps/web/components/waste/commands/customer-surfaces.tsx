"use client"
// A customer's details on the Pilot: its Statement (#291 C6) and its
// Sustainability report (M13 of #293), each a section of its own, keyed by
// the customer so a window picked for one is not another's.
import { SustainabilitySection } from "@/components/customers/sustainability-section"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"

import { CustomerStatementSurface } from "./payment-surfaces"

export function CustomerCommandsSurface({ record }: RowSurfaceProps) {
  return (
    <div className="space-y-6">
      <CustomerStatementSurface key={`statement-${record.id}`} record={record} />
      <SustainabilitySection key={`sustainability-${record.id}`} record={record} />
    </div>
  )
}
