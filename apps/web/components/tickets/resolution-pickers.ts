"use client"
// The pickers the tickets' and the alerts' dialogs read (Issue #182, for
// #147): the command surfaces' own (`useRelationPickers`) — the project, the
// customer, the property, the agreement, the driver, the vehicle — and the
// rows Resolution names beside them: the accounts a ticket is assigned to
// (Users & roles), the routes and the re-collection's route (Route Studio),
// the containers, the shared points and the tickets themselves. Each reads
// the module the store loaded and offers nothing before it has answered.
//
// A picker hides no row by status — a status gates a new reference and never
// an existing one, and the API's 409 says why (#79) — but for one: the
// re-collection's route is picked among the routes that have not ended,
// which is the reference's own rule (#126), and an optional pick offers None
// first, since a select cannot be emptied.
import { useModuleRecords } from "@/components/waste/business-record-store"
import { useRelationPickers, type RelationPickers } from "@/components/waste/commands/use-command-support"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { ROUTES_MODULE } from "@/lib/api/records/routes"
import { TICKETS_MODULE } from "@/lib/api/records/tickets"
import { AGREEMENTS_MODULE, isAgreementRecord } from "@/lib/data/agreements"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { keptOptions, keptValue } from "@/lib/data/place-pickers"
import { NO_ONE, SHARED_POINTS_MODULE } from "@/lib/data/properties"
import { ACCESS_MODULE } from "@/lib/data/tickets"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const NO_RECORDS: readonly BusinessRecord[] = []
const fixturesOf = (location: ModuleLocation) => getModuleDefinition(location)?.records ?? NO_RECORDS
const keyOf = (location: ModuleLocation) => `${location.workspaceId}.${location.moduleId}`

/** A route has ended once it is completed or cancelled: no re-collection rides on it. */
const ENDED = new Set(["Completed", "Cancelled"])

/** A row as a Resolution picker offers it: its name, what tells it apart, and its status where it is not Active. */
const optionOf = (record: BusinessRecord, ...said: Array<string | undefined>): BusinessFormOption => ({
  value: record.id,
  label: [record.name, ...said, record.status === "Active" ? undefined : record.status].filter(Boolean).join(" · "),
})

/** The rows of the project the form names, every row where it names none; a row of no project serves every one. */
const inProject = (records: readonly BusinessRecord[], projectId: string | undefined) =>
  records.filter((record) => !isSoftDeleted(record) && (projectId === undefined || !record.projectIds?.length || record.projectIds.includes(projectId)))

/** The Resolution dialogs' pickers: the command surfaces' own, and the rows a ticket and an alert name beside them. */
export function useResolutionPickers(): RelationPickers {
  const base = useRelationPickers()
  const users = useModuleRecords(ACCESS_MODULE.workspaceId, ACCESS_MODULE.moduleId, fixturesOf(ACCESS_MODULE))
  const routes = useModuleRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, fixturesOf(ROUTES_MODULE))
  const containers = useModuleRecords(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId, fixturesOf(CONTAINERS_MODULE))
  const points = useModuleRecords(SHARED_POINTS_MODULE.workspaceId, SHARED_POINTS_MODULE.moduleId, fixturesOf(SHARED_POINTS_MODULE))
  const agreements = useModuleRecords(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId, fixturesOf(AGREEMENTS_MODULE))
  const tickets = useModuleRecords(TICKETS_MODULE.workspaceId, TICKETS_MODULE.moduleId, fixturesOf(TICKETS_MODULE))
  const own = new Map([
    [keyOf(ACCESS_MODULE), users],
    [keyOf(ROUTES_MODULE), routes],
    [keyOf(CONTAINERS_MODULE), containers],
    [keyOf(SHARED_POINTS_MODULE), points],
    [keyOf(TICKETS_MODULE), tickets],
  ])

  const rowsFor = (field: BusinessFormField, projectId: string | undefined): readonly BusinessFormOption[] | undefined => {
    const optional = (options: readonly BusinessFormOption[]) => (field.required ? options : [{ value: NO_ONE, label: "None" }, ...options])
    switch (field.id) {
      // An account of the company working in the project: one with every project, or this one among its own; a provider's account works through its provider.
      case "assigneeUserAccountId":
        return optional(
          inProject(users.records, projectId)
            .filter((record) => record.recordKind === "User" && record.serviceProviderId === undefined)
            .map((record) => optionOf(record)),
        )
      case "routeId":
        return optional(inProject(routes.records, projectId).map((record) => optionOf(record, record.facts["Operating date"])))
      case "recollectionRouteId":
        return inProject(routes.records, projectId)
          .filter((record) => !ENDED.has(record.status))
          .map((record) => optionOf(record, record.facts["Operating date"]))
      case "containerId":
        return optional(inProject(containers.records, projectId).map((record) => optionOf(record)))
      case "sharedCollectionPointId":
        return optional(inProject(points.records, projectId).map((record) => optionOf(record)))
      case "agreementId":
        return optional(inProject(agreements.records, projectId).filter(isAgreementRecord).map((record) => optionOf(record)))
      case "ticketId":
        return inProject(tickets.records, projectId).map((record) => ({ value: record.id, label: [record.facts.Ticket, record.name, record.status].filter(Boolean).join(" · ") }))
      default:
        return undefined
    }
  }

  const options = (field: BusinessFormField, values: BusinessFormValues, projectId?: string, opened?: BusinessFormValues): readonly BusinessFormOption[] => {
    const project = projectId ?? (typeof values.projectId === "string" && values.projectId !== "" ? values.projectId : undefined)
    const rows = rowsFor(field, project)
    if (rows !== undefined) return keptOptions(field, rows, keptValue(field.id, values, opened))
    const shared = base.options(field, values, projectId, opened)
    // An optional pick of the shared pickers — a property, a driver, a vehicle — takes None first as well.
    const optionalPick = field.type === "select" && !field.required && field.relation !== undefined && shared[0]?.value !== NO_ONE
    return optionalPick ? [{ value: NO_ONE, label: "None" }, ...shared] : shared
  }

  // A module the role does not view is nothing to wait for: its picker offers what the person has (Issue #217).
  const readyFor = (schema: BusinessFormSchema) =>
    base.readyFor(schema) &&
    schema.sections.every((section) =>
      section.fields.every((field) => {
        const state = field.relation === undefined ? undefined : own.get(keyOf(field.relation))
        return state === undefined || state.ready || state.notGranted
      }),
    )

  return { readyFor, options, timezoneOf: base.timezoneOf }
}
