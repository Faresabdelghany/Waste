"use client"
// A customer's details on the Pilot: its Statement (#291 C6), its
// Sustainability report (M13 of #293) and the export of everything held
// about it (#291 C19), each a section of its own, keyed by the customer so a
// window picked for one is not another's.
import { CustomerExportSection } from "@/components/customers/customer-export-section"
import { SustainabilitySection } from "@/components/customers/sustainability-section"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"

import { CustomerStatementSurface } from "./payment-surfaces"

export function CustomerCommandsSurface({ record }: RowSurfaceProps) {
  return (
    <div className="space-y-6">
      <CustomerStatementSurface key={`statement-${record.id}`} record={record} />
      <SustainabilitySection key={`sustainability-${record.id}`} record={record} />
      <CustomerExportSection key={`export-${record.id}`} record={record} />
    </div>
  )
}
