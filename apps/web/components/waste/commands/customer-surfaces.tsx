"use client"
// A customer's details on the Pilot: an organisation's Contact Persons
// (#291 C14), its Messages (#291 C15), its Statement (#291 C6) and the
// export of everything held about it (#291 C19), each a section of its own,
// keyed by the customer so a window picked for one is not another's.
import { CustomerExportSection } from "@/components/customers/customer-export-section"
import type { RowSurfaceProps } from "@/components/platform/surface-props"

import { ContactPersonsSurface } from "./contact-person-surfaces"
import { MessagesSurface } from "./message-surfaces"
import { CustomerStatementSurface } from "./payment-surfaces"

export function CustomerCommandsSurface({ record }: RowSurfaceProps) {
  return (
    <div className="space-y-6">
      <ContactPersonsSurface key={`contacts-${record.id}`} record={record} />
      <MessagesSurface key={`messages-${record.id}`} record={record} />
      <CustomerStatementSurface key={`statement-${record.id}`} record={record} />
      <CustomerExportSection key={`export-${record.id}`} record={record} />
    </div>
  )
}
