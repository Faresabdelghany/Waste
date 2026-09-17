// TRANSITIONAL COUPLING — read before adding to this file.
//
// The domain logic in this package still takes the prototype's generic
// `BusinessRecord`: a presentation model whose `facts` are display strings
// (`Fact` is presentation-only per CONTEXT.md) and whose `submittedValues`
// carry the typed form payload. It moved here as-is so that packages/domain
// has no dependency on the fixture registry in apps/web; that registry
// (lib/data/business-modules) re-exports the name, so web imports did not
// change.
//
// Replacing it with typed Route Scheme, Collection Group, and Container
// inputs is the Planning step of the build order, not this package's job
// today. Do not grow this file into a second registry: no fixture ids, no
// module lists, no workspace or form vocabulary.

/** One typed form value. */
export type SubmittedValue = string | boolean

/** The typed form payload a record carries. */
export type SubmittedValues = Record<string, SubmittedValue>

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
  submittedValues?: SubmittedValues
  relationRefs?: Array<{
    fieldId: string
    /** A web workspace id. The union of ids is the web registry's, not the domain's. */
    workspaceId: string
    moduleId: string
    recordId: string
    label: string
  }>
}
