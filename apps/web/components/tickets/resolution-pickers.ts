"use client"
// The pickers the tickets' and the alerts' dialogs read (Issue #182, for
// #147): the command surfaces' own (`useRelationPickers`) — the project, the
// customer, the property, the agreement, the driver, the vehicle — and the
// rows Resolution names beside them: the accounts a ticket is assigned to
// (Users & roles), the routes and the re-collection's route (Route Studio),
// the containers, the shared points, the tickets themselves — an alert's
// ticket and a sub-ticket's parent — and the ticket teams (O30 of #290). Each reads the module the store loaded
// and offers nothing before it has answered.
//
// A picker hides no row by status — a status gates a new reference and never
// an existing one, and the API's 409 says why (#79) — but for one: the
// re-collection's route is picked among the routes that have not ended,
// which is the reference's own rule (#126), and its stop (#111) among that
// route's stops that are planned or collected — the API refuses a missed one
// — and a completion's product (#291 C3) among the project's not sold by the
// month, a recurring charge being no ticket's work; an optional pick offers
// None first, since a select cannot be emptied, and the product's None leaves
// the project's charge for the ticket's kind to stand in.
// The stop a ticket is about (M6 of #293) is one of its route's, of any
// outcome: a missed one is what a complaint is about.
import { useModuleRecords } from "@/components/waste/business-record-store"
import { useRelationPickers, type RelationPickers } from "@/components/waste/commands/use-command-support"
import { moduleKeyOf } from "@/lib/api/records/adapter"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { PICKUPS_MODULE } from "@/lib/api/records/pickups"
import { ROUTES_MODULE } from "@/lib/api/records/routes"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import { TICKET_NUMBER_FACT, TICKETS_MODULE } from "@/lib/api/records/tickets"
import { AGREEMENTS_MODULE, isAgreementRecord } from "@/lib/data/agreements"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { keptOptions, keptValue } from "@/lib/data/place-pickers"
import { NO_ONE, SHARED_POINTS_MODULE } from "@/lib/data/properties"
import { ticketWorkProductOptions } from "@/lib/data/ticket-charges"
import { TICKET_TEAMS_MODULE } from "@/lib/data/ticket-teams"
import { ACCESS_MODULE, recollectionStopOptions, ticketStopOptions } from "@/lib/data/tickets"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const NO_RECORDS: readonly BusinessRecord[] = []
const fixturesOf = (location: ModuleLocation) => getModuleDefinition(location)?.records ?? NO_RECORDS
const keyOf = (location: ModuleLocation) => moduleKeyOf(location.workspaceId, location.moduleId)

/** A route has ended once it is completed or cancelled: no re-collection rides on it. */
const ENDED = new Set(["Completed", "Cancelled"])

/** A row as a Resolution picker offers it: its name, what tells it apart, and its status where it is not Active. */
const optionOf = (record: BusinessRecord, ...said: Array<string | undefined>): BusinessFormOption => ({
  value: record.id,
  label: [record.name, ...said, record.status === "Active" ? undefined : record.status].filter(Boolean).join(" · "),
})

/** A ticket as a picker offers it: its number, its subject, its status. */
const ticketOption = (record: BusinessRecord): BusinessFormOption => ({ value: record.id, label: [record.facts[TICKET_NUMBER_FACT], record.name, record.status].filter(Boolean).join(" · ") })

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
  const pickups = useModuleRecords(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, fixturesOf(PICKUPS_MODULE))
  const products = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, fixturesOf(PRODUCTS_MODULE))
  // The ticket teams (O30 of #290): the API's alone, so no fixture stands in for one.
  const teams = useModuleRecords(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId, NO_RECORDS)
  // The modules a dialog waits on. Not the stops: the re-collection's stop is
  // optional and a recollected completion's alone, so a Complete answering
  // otherwise is never held back by the stops' read — before it lands the
  // stop's picker offers None, the route alone.
  const own = new Map([
    [keyOf(ACCESS_MODULE), users],
    [keyOf(ROUTES_MODULE), routes],
    [keyOf(CONTAINERS_MODULE), containers],
    [keyOf(SHARED_POINTS_MODULE), points],
    [keyOf(TICKETS_MODULE), tickets],
    [keyOf(TICKET_TEAMS_MODULE), teams],
  ])

  const rowsFor = (field: BusinessFormField, projectId: string | undefined, values: BusinessFormValues): readonly BusinessFormOption[] | undefined => {
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
      // The stop of the picked route the re-collection is: none until a route is picked, then its stops still to collect or collected.
      case "recollectionPickupId":
        return recollectionStopOptions(pickups.records, typeof values.recollectionRouteId === "string" ? values.recollectionRouteId : undefined)
      // The stop a ticket is about: the picked route's, whatever their outcome.
      case "pickupId":
        return ticketStopOptions(pickups.records, typeof values.routeId === "string" ? values.routeId : undefined)
      // The product a re-collection's or a service's work is charged at: optional, so the dialog never waits on the products, as it never does on the stops.
      case "productId":
        return [{ value: NO_ONE, label: "None: the ticket kind's charge" }, ...ticketWorkProductOptions(products.records, projectId)]
      case "containerId":
        return optional(inProject(containers.records, projectId).map((record) => optionOf(record)))
      case "sharedCollectionPointId":
        return optional(inProject(points.records, projectId).map((record) => optionOf(record)))
      case "agreementId":
        return optional(inProject(agreements.records, projectId).filter(isAgreementRecord).map((record) => optionOf(record)))
      case "ticketId":
        return inProject(tickets.records, projectId).map(ticketOption)
      // The case a ticket is part of (7.10 of #290): a ticket of its project, optional.
      case "parentTicketId":
        return optional(inProject(tickets.records, projectId).map(ticketOption))
      // The team a new ticket waits with (O30 of #290): an active one, or None for no team; left blank, the project's default for the kind.
      case "teamId":
        return [{ value: NO_ONE, label: "None: no team" }, ...teams.records.filter((record) => isTicketTeamRecord(record) && record.status === "Active").map((record) => optionOf(record))]
      default:
        return undefined
    }
  }

  const options = (field: BusinessFormField, values: BusinessFormValues, projectId?: string, opened?: BusinessFormValues): readonly BusinessFormOption[] => {
    const project = projectId ?? (typeof values.projectId === "string" && values.projectId !== "" ? values.projectId : undefined)
    const rows = rowsFor(field, project, values)
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
