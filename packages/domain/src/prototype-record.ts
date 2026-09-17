// TRANSITIONAL COUPLING — read before adding to this file.
//
// The domain logic in this package still takes the prototype's generic
// `BusinessRecord`: a presentation model whose `facts` are display strings
// (`Fact` is presentation-only per CONTEXT.md) and whose `submittedValues`
// carry the typed form payload. It moved here as-is, together with the two
// small types it needs, so that packages/domain has no dependency on the
// fixture registry in apps/web (lib/data/business-modules re-exports these
// three names, so web imports did not change).
//
// Replacing it with typed Route Scheme, Collection Group, and Container
// inputs is the Planning step of the build order, not this package's job
// today. Do not grow this file into a second registry: no fixture ids, no
// module lists, no per-workspace knowledge beyond the id union below.

/** The workspaces a relation reference can point into. */
export type WorkspaceId =
  | "operate"
  | "plan"
  | "route-studio"
  | "fleet"
  | "customers"
  | "resources"
  | "service-providers"
  | "commercial"
  | "improve"
  | "configure"
  | "control-center"

export type BusinessRecord = {
  id: string
  name: string
  context: string
  status: string
  owner: string
  value: string
  updated: string
  description: string
  facts: Record<string, string>
  related: string[]
  source: string
  freshness: string
  allowedTransitions?: string[]
  deepLink?: string
  /**
   * Fixture records always carry explicit scope. These remain optional so
   * temporary, client-created records can be introduced before persistence
   * assigns their canonical scope.
   */
  companyId?: string
  projectIds?: string[]
  serviceProviderId?: string
  /**
   * Client-created records retain their typed form payload and relation
   * references so later forms can use them as real upstream choices instead
   * of relying on flattened display text.
   */
  recordKind?: string
  submittedValues?: Record<string, string | boolean>
  relationRefs?: Array<{
    fieldId: string
    workspaceId: WorkspaceId
    moduleId: string
    recordId: string
    label: string
  }>
}

/** One selectable choice, as the prototype's form fields list them. */
export type BusinessFormOption = {
  value: string
  label: string
  /** Listed but not selectable — the label carries the reason. */
  disabled?: boolean
}
