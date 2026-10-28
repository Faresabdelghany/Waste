// Service Provider Activities (#474, @waste/domain/service-providers/
// activities): one item of coordination between the office and one Service
// Provider, under `service-providers.activities`. `GET
// /service-provider-activities` lists them, `POST` opens one, `GET`/`PATCH
// /service-provider-activities/:id` read one and correct it while it is open,
// and five commands close it — `approve`, `reject` and `withdraw` a proposal,
// `complete` and `cancel` the rest — each taken by the kinds and the sides the
// domain's `closesWith` says. No delete: an Activity is closed, and its
// history is the audit log of its row.
//
// Both sides reach it. An office account reaches the Activities of its
// projects (`inProjects`); a provider's account reaches its own provider's,
// in whatever project they are (`service_provider_id`), as it reaches its own
// fleet (`reachesFleet`) — never both widened. A provider opens a proposal or
// a note for its own provider alone, in a project where it holds an award in
// force (`requireReachedProject`); the office opens any kind for a provider
// assigned a Service Area in the project at some time.
//
// A proposal is about a scheme its provider serves on the day it would apply
// from (`servesScheme`, the award rule `servesRoute` reads), and approving it
// applies it: the scheme's next version from that day, written through the
// successor command (`writeSuccessor`, routes/scheme-lifecycle.ts) with the
// change amended into the version's body, so the new version is held to every
// rule a create is held to and the predecessor's routes from the day are ended
// as a successor ends them, in the approval's transaction. Approving takes
// `create` on `route-studio.schemes` beside the decision's `edit`, the
// successor's own grant: an approval never writes what its approver could not
// write directly. Whatever the scheme's rules refuse refuses the approval, a
// 409 in the command's own sentence, and the proposal stays pending. No outbox
// event is written: nobody consumes one yet (#474, until the messaging
// foundation, #291 C15).
//
// The number is the company's running count, `ACT-<n>`, the highest plus one
// under the company's row lock, as an Application's is.
import { Page } from "@waste/contracts/pagination"
import type { RouteScheme, RouteSchemeCreate } from "@waste/contracts/route-schemes"
import {
  ActivityClose,
  ActivityReject,
  ServiceProviderActivity,
  ServiceProviderActivityCreate,
  ServiceProviderActivityListQuery,
  ServiceProviderActivityPatch,
  type ActivityKind,
  type ActivityStatus,
} from "@waste/contracts/service-provider-activities"
import type { Tx } from "@waste/db/client"
import { serviceArea, serviceAreaAssignment } from "@waste/db/schema/finance"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { company, serviceProvider } from "@waste/db/schema/organisation"
import { collectionGroup, collectionGroupContainer, routeScheme } from "@waste/db/schema/route-schemes"
import { container } from "@waste/db/schema/containers"
import { serviceProviderActivity, serviceProviderActivityContainer } from "@waste/db/schema/service-provider-activities"
import type { JobSender } from "@waste/db/jobs"
import { firstEndingDay } from "@waste/domain/planning/lifecycle"
import type { RecurrenceFrequency, ServiceDay } from "@waste/domain/planning/vocabulary"
import {
  activityLabel,
  closesWith,
  correctedBy,
  createRefusal,
  isProposal,
  OPEN_STATUSES,
  routeDayChangeRefusal,
  RULE_GROUP_STOPS,
  serviceDaysAfter,
  stopSetChangeRefusal,
  vehicleChangeRefusal,
  type ActivityCommand,
  type ActivitySide,
} from "@waste/domain/service-providers/activities"
import { and, asc, eq, gt, inArray, max, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { notOwnFleet, providerIdOf, providerNameOf, requireReachedProject, servesScheme } from "../auth/provider"
import { requireAllowed, requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, ProblemError, validate } from "../problem"
import { projectToday } from "./fleet-lookups"
import { NOT_A_DRIVER, NOT_A_POWERED_VEHICLE, requireServiceProvider } from "./references"
import { successorStartsInside, writeSuccessor } from "./scheme-lifecycle"
import { requireNotArchived, MODULE as SCHEMES } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, stamp, stampsOf } from "./shared"

const MODULE = "service-providers.activities"
const ActivityPage = Page(ServiceProviderActivity)

const columns = {
  id: serviceProviderActivity.id,
  projectId: serviceProviderActivity.projectId,
  number: serviceProviderActivity.number,
  kind: serviceProviderActivity.kind,
  status: serviceProviderActivity.status,
  serviceProviderId: serviceProviderActivity.serviceProviderId,
  serviceAreaId: serviceProviderActivity.serviceAreaId,
  subject: serviceProviderActivity.subject,
  body: serviceProviderActivity.body,
  dueOn: serviceProviderActivity.dueOn,
  routeSchemeId: serviceProviderActivity.routeSchemeId,
  collectionGroupId: serviceProviderActivity.collectionGroupId,
  serviceDays: serviceProviderActivity.serviceDays,
  effectiveFrom: serviceProviderActivity.effectiveFrom,
  vehicleId: serviceProviderActivity.vehicleId,
  driverId: serviceProviderActivity.driverId,
  successorSchemeId: serviceProviderActivity.successorSchemeId,
  openedBy: serviceProviderActivity.openedBy,
  closedBy: serviceProviderActivity.closedBy,
  closedAt: serviceProviderActivity.closedAt,
  closeReason: serviceProviderActivity.closeReason,
  createdAt: serviceProviderActivity.createdAt,
  updatedAt: serviceProviderActivity.updatedAt,
}
type Row = Pick<typeof serviceProviderActivity.$inferSelect, keyof typeof columns>

const activityOf = (row: Row, containerIds: string[] | null = null): ServiceProviderActivity => ({
  id: row.id,
  projectId: row.projectId,
  number: row.number,
  kind: row.kind as ActivityKind,
  status: row.status as ActivityStatus,
  serviceProviderId: row.serviceProviderId,
  serviceAreaId: row.serviceAreaId,
  subject: row.subject,
  body: row.body,
  dueOn: row.dueOn,
  routeSchemeId: row.routeSchemeId,
  collectionGroupId: row.collectionGroupId,
  serviceDays: row.serviceDays as ServiceDay[] | null,
  effectiveFrom: row.effectiveFrom,
  vehicleId: row.vehicleId,
  driverId: row.driverId,
  containerIds,
  successorSchemeId: row.successorSchemeId,
  openedBy: row.openedBy,
  closedBy: row.closedBy,
  closedAt: row.closedAt?.toISOString() ?? null,
  closeReason: row.closeReason,
  ...stampsOf(row),
})

/** Each stop-set change's containers, in stop order, by activity id, in one statement; an activity of another kind has none. */
async function containersOf(tx: Tx, companyId: string, rows: readonly Row[]): Promise<Map<string, string[]>> {
  const ids = rows.filter((row) => row.kind === "stop-set-change").map((row) => row.id)
  const sets = new Map<string, string[]>(ids.map((id) => [id, []]))
  if (ids.length === 0) return sets
  const members = await tx
    .select({ activityId: serviceProviderActivityContainer.activityId, containerId: serviceProviderActivityContainer.containerId })
    .from(serviceProviderActivityContainer)
    .where(and(eq(serviceProviderActivityContainer.companyId, companyId), inArray(serviceProviderActivityContainer.activityId, ids)))
    .orderBy(asc(serviceProviderActivityContainer.activityId), asc(serviceProviderActivityContainer.position))
  for (const member of members) sets.get(member.activityId)?.push(member.containerId)
  return sets
}

/** Activities on the wire, each stop-set change with its containers. */
async function answers(tx: Tx, companyId: string, rows: readonly Row[]): Promise<ServiceProviderActivity[]> {
  const sets = await containersOf(tx, companyId, rows)
  return rows.map((row) => activityOf(row, sets.get(row.id) ?? null))
}

/** One Activity on the wire. */
const answer = async (tx: Tx, companyId: string, row: Row): Promise<ServiceProviderActivity> => (await answers(tx, companyId, [row]))[0]

/** A stop-set change's containers written as its set, replacing whatever it held, in stop order. */
async function writeContainers(tx: Tx, row: Pick<Row, "id" | "projectId">, companyId: string, containerIds: readonly string[]): Promise<void> {
  await tx.delete(serviceProviderActivityContainer).where(and(eq(serviceProviderActivityContainer.companyId, companyId), eq(serviceProviderActivityContainer.activityId, row.id)))
  await tx.insert(serviceProviderActivityContainer).values(containerIds.map((containerId, index) => ({ id: newId(), companyId, projectId: row.projectId, activityId: row.id, containerId, position: index + 1 })))
}

/** The side of an Activity the caller is on: a provider's account, or the office's. */
const sideOf = (principal: Principal): ActivitySide => (providerIdOf(principal) === null ? "office" : "provider")

/** The rows the caller reaches: its own provider's for a provider's account, its projects' for the office's; never both widened. */
function reach(principal: Principal) {
  const providerId = providerIdOf(principal)
  const fence = providerId === null ? inProjects(serviceProviderActivity.projectId, principal) : eq(serviceProviderActivity.serviceProviderId, providerId)
  return and(eq(serviceProviderActivity.companyId, principal.companyId), fence)
}

const noSuchActivity = (id: string) => problem(404, { detail: `No service provider activity ${id} this account reaches` })

async function findActivity(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(serviceProviderActivity)
    .where(and(reach(principal), eq(serviceProviderActivity.id, id)))
    .limit(1)
  return row
}

export const NOT_A_SCHEME = "Not a route scheme of this project"
export const NOT_A_GROUP_OF_THE_SCHEME = "Not a collection group of this scheme"
export const notOwnProvider = (provider: string): string => `${provider} opens activities for itself alone`
export const holdsNoServiceArea = (provider: string): string => `${provider} holds no Service Area in this project`
export const notAnAwardOf = (provider: string): string => `Not a Service Area ${provider} is assigned in this project`
export const appliesFromTomorrow = (tomorrow: string): string => `Today's routes are operating: a proposal applies from ${tomorrow} at the earliest`
export const groupParked = (name: string): string => `${name} is parked: it runs on no day, so there are no days of it to move`
export const notServed = (provider: string, day: string): string => `${provider} does not serve this scheme on ${day}: no Service Area assigned to it then holds the scheme's planning area`
export const KIND_CARRIES_NOT = "Not a member of this kind of activity"

/** A refusal judged on a proposal: a 400 at its field when the body is the caller's, a 409 in one sentence when the row is. */
type ProposalRefusal = { status: 400 | 409; path: string; message: string }

/** The scheme and the group a proposal names, as its rules read them. */
type Subject = { scheme: { id: string; name: string; validFrom: string; validTo: string | null; archivedAt: Date | null }; group: { id: string; name: string; days: string[]; stopSource: string; vehicleId: string | null; driverId: string | null } }

/** What a proposal asks, by kind: a route-day change the group's days, a vehicle change its vehicle and, where named, its driver; both from a day. */
type Proposal = { routeSchemeId: string; collectionGroupId: string; effectiveFrom: string } & (
  | { kind: "route-day-change"; serviceDays: readonly ServiceDay[] }
  | { kind: "vehicle-change"; vehicleId: string; driverId: string | null }
  | { kind: "stop-set-change"; containerIds: readonly string[] }
)

/** A stored proposal as its rules read it again, a stop-set change with the containers its set holds. */
async function proposalOf(tx: Tx, companyId: string, row: Row): Promise<Proposal> {
  const base = { routeSchemeId: row.routeSchemeId as string, collectionGroupId: row.collectionGroupId as string, effectiveFrom: row.effectiveFrom as string }
  if (row.kind === "vehicle-change") return { ...base, kind: "vehicle-change", vehicleId: row.vehicleId as string, driverId: row.driverId }
  if (row.kind === "stop-set-change") return { ...base, kind: "stop-set-change", containerIds: (await containersOf(tx, companyId, [row])).get(row.id) ?? [] }
  return { ...base, kind: "route-day-change", serviceDays: row.serviceDays as ServiceDay[] }
}

export const NOT_A_CONTAINER = "Not a container of this project"

/**
 * A stop-set change's list held to its group: the group picks its stops (a
 * rule group's are its rule's, which a waste-fraction change moves), every
 * container is the project's, and the list moves a stop or their order. The
 * first refusal at its field, or null.
 */
async function stopsRefusal(tx: Tx, scope: { companyId: string; projectId: string }, group: { id: string; stopSource: string }, containerIds: readonly string[]): Promise<ProposalRefusal | null> {
  if (group.stopSource !== "manual") return { status: 400, path: "collectionGroupId", message: RULE_GROUP_STOPS }
  const found = await tx
    .select({ id: container.id })
    .from(container)
    .where(and(eq(container.companyId, scope.companyId), eq(container.projectId, scope.projectId), inArray(container.id, [...containerIds])))
  const known = new Set(found.map((row) => row.id))
  const missing = containerIds.findIndex((id) => !known.has(id))
  if (missing !== -1) return { status: 400, path: `containerIds.${missing}`, message: NOT_A_CONTAINER }
  const current = await tx
    .select({ containerId: collectionGroupContainer.containerId })
    .from(collectionGroupContainer)
    .where(and(eq(collectionGroupContainer.companyId, scope.companyId), eq(collectionGroupContainer.collectionGroupId, group.id)))
    .orderBy(asc(collectionGroupContainer.position))
  const same = stopSetChangeRefusal(current.map((row) => row.containerId), containerIds)
  return same === null ? null : { status: 400, path: "containerIds", message: same }
}

/**
 * A vehicle change's crew, each the project's: the vehicle a powered one,
 * the driver where it names one; and where `ownFleet` names the provider
 * that opens it — a provider's account — both of that provider's own fleet
 * (`reachesFleet`'s rule). The first refusal at its field, or null.
 */
async function crewRefusal(tx: Tx, scope: { companyId: string; projectId: string; provider: string; ownFleet: string | null }, proposal: { vehicleId: string; driverId: string | null }): Promise<ProposalRefusal | null> {
  const [truck] = await tx
    .select({ serviceProviderId: vehicle.serviceProviderId })
    .from(vehicle)
    .where(and(eq(vehicle.companyId, scope.companyId), eq(vehicle.projectId, scope.projectId), eq(vehicle.id, proposal.vehicleId), eq(vehicle.kind, "powered-vehicle")))
    .limit(1)
  if (truck === undefined) return { status: 400, path: "vehicleId", message: NOT_A_POWERED_VEHICLE }
  if (scope.ownFleet !== null && truck.serviceProviderId !== scope.ownFleet) return { status: 400, path: "vehicleId", message: notOwnFleet("vehicle", scope.provider) }
  if (proposal.driverId === null) return null
  const [person] = await tx
    .select({ serviceProviderId: driver.serviceProviderId })
    .from(driver)
    .where(and(eq(driver.companyId, scope.companyId), eq(driver.projectId, scope.projectId), eq(driver.id, proposal.driverId)))
    .limit(1)
  if (person === undefined) return { status: 400, path: "driverId", message: NOT_A_DRIVER }
  if (scope.ownFleet !== null && person.serviceProviderId !== scope.ownFleet) return { status: 400, path: "driverId", message: notOwnFleet("driver", scope.provider) }
  return null
}

/**
 * A proposal judged against the scheme as it stands, in the API's order: the
 * 400s at the fields — the scheme the project's, the group the scheme's, what
 * the kind asks (a route-day change's days moved; a vehicle change's crew the
 * project's, a provider's own, and moved; a stop-set change's group picking
 * its stops and its list the project's and moved), the first day tomorrow at the earliest and inside
 * the scheme's period, which the successor holds it to — then the 409s the
 * rows decide: the scheme not archived, the group running, and the provider
 * serving the scheme on the day. The first refusal, or the subject.
 */
async function judgeProposal(
  tx: Tx,
  scope: { companyId: string; projectId: string; serviceProviderId: string; provider: string; ownFleet: string | null },
  proposal: Proposal,
  now: () => Date,
): Promise<ProposalRefusal | Subject> {
  const [scheme] = await tx
    .select({ id: routeScheme.id, name: routeScheme.name, validFrom: routeScheme.validFrom, validTo: routeScheme.validTo, archivedAt: routeScheme.archivedAt })
    .from(routeScheme)
    .where(and(eq(routeScheme.companyId, scope.companyId), eq(routeScheme.projectId, scope.projectId), eq(routeScheme.id, proposal.routeSchemeId)))
    .limit(1)
  if (scheme === undefined) return { status: 400, path: "routeSchemeId", message: NOT_A_SCHEME }
  const [group] = await tx
    .select({ id: collectionGroup.id, name: collectionGroup.name, days: collectionGroup.days, stopSource: collectionGroup.stopSource, vehicleId: collectionGroup.vehicleId, driverId: collectionGroup.driverId })
    .from(collectionGroup)
    .where(and(eq(collectionGroup.companyId, scope.companyId), eq(collectionGroup.routeSchemeId, scheme.id), eq(collectionGroup.id, proposal.collectionGroupId)))
    .limit(1)
  if (group === undefined) return { status: 400, path: "collectionGroupId", message: NOT_A_GROUP_OF_THE_SCHEME }
  if (proposal.kind === "route-day-change") {
    const same = routeDayChangeRefusal(group.days as ServiceDay[], proposal.serviceDays)
    if (same !== null) return { status: 400, path: "serviceDays", message: same }
  } else if (proposal.kind === "vehicle-change") {
    const crew = await crewRefusal(tx, scope, proposal)
    if (crew !== null) return crew
    const same = vehicleChangeRefusal(group, proposal)
    if (same !== null) return { status: 400, path: "vehicleId", message: same }
  } else {
    const stops = await stopsRefusal(tx, scope, group, proposal.containerIds)
    if (stops !== null) return stops
  }
  const tomorrow = firstEndingDay(await projectToday(tx, { companyId: scope.companyId, projectId: scope.projectId }, now)())
  if (proposal.effectiveFrom < tomorrow) return { status: 400, path: "effectiveFrom", message: appliesFromTomorrow(tomorrow) }
  if (proposal.effectiveFrom <= scheme.validFrom || (scheme.validTo !== null && proposal.effectiveFrom >= scheme.validTo)) return { status: 400, path: "effectiveFrom", message: successorStartsInside(scheme) }
  try {
    requireNotArchived(scheme)
  } catch (error) {
    if (error instanceof ProblemError) return { status: 409, path: "routeSchemeId", message: error.body.detail ?? error.message }
    throw error
  }
  if (group.days.length === 0) return { status: 409, path: "collectionGroupId", message: groupParked(group.name) }
  if (!(await servesScheme(tx, { companyId: scope.companyId, serviceProviderId: scope.serviceProviderId, routeSchemeId: scheme.id }, proposal.effectiveFrom)))
    return { status: 409, path: "routeSchemeId", message: notServed(scope.provider, proposal.effectiveFrom) }
  return { scheme, group }
}

/** A proposal's refusal as an open or a correction answers it: at its field, or in one sentence. */
function refuseProposal(refusal: ProposalRefusal): never {
  if (refusal.status === 400) throw invalidRequest("body", [{ path: refusal.path, message: refusal.message }])
  throw problem(409, { detail: refusal.message })
}

/** The provider's legal name, as a sentence names it. */
async function providerName(tx: Tx, companyId: string, id: string): Promise<string> {
  const [row] = await tx
    .select({ legalName: serviceProvider.legalName })
    .from(serviceProvider)
    .where(and(eq(serviceProvider.companyId, companyId), eq(serviceProvider.id, id)))
    .limit(1)
  return row?.legalName ?? "The service provider"
}

/** A Service Area the provider is or was assigned in the project, where the body names one: the award the Activity is about. */
async function requireAward(tx: Tx, scope: { companyId: string; projectId: string; serviceProviderId: string; provider: string }, id: string | null | undefined): Promise<void> {
  if (id == null) return
  const [held] = await tx
    .select({ one: sql`1` })
    .from(serviceAreaAssignment)
    .innerJoin(serviceArea, and(eq(serviceArea.companyId, serviceAreaAssignment.companyId), eq(serviceArea.id, serviceAreaAssignment.serviceAreaId)))
    .where(and(eq(serviceAreaAssignment.companyId, scope.companyId), eq(serviceArea.projectId, scope.projectId), eq(serviceAreaAssignment.serviceAreaId, id), eq(serviceAreaAssignment.serviceProviderId, scope.serviceProviderId)))
    .limit(1)
  if (held === undefined) throw invalidRequest("body", [{ path: "serviceAreaId", message: notAnAwardOf(scope.provider) }])
}

/**
 * The provider a create names, held to the caller's side: a provider's
 * account names its own provider alone; the office names one of the
 * company's that is or was assigned a Service Area in the project.
 */
async function requireProviderOf(tx: Tx, principal: Principal, projectId: string, serviceProviderId: string): Promise<string> {
  const own = providerIdOf(principal)
  if (own !== null) {
    if (serviceProviderId !== own) throw invalidRequest("body", [{ path: "serviceProviderId", message: notOwnProvider(providerNameOf(principal)) }])
    return providerNameOf(principal)
  }
  await requireServiceProvider(tx, principal.companyId, serviceProviderId)
  const name = await providerName(tx, principal.companyId, serviceProviderId)
  const [held] = await tx
    .select({ one: sql`1` })
    .from(serviceAreaAssignment)
    .where(and(eq(serviceAreaAssignment.companyId, principal.companyId), eq(serviceAreaAssignment.projectId, projectId), eq(serviceAreaAssignment.serviceProviderId, serviceProviderId)))
    .limit(1)
  if (held === undefined) throw invalidRequest("body", [{ path: "serviceProviderId", message: holdsNoServiceArea(name) }])
  return name
}

/**
 * The amendment an approved route-day change makes to the scheme's next
 * version: the group — found by its place among the predecessor's, since the
 * version's body lists them in the same order — runs on the proposed days,
 * and the scheme serves the days its groups run on (`serviceDaysAfter`).
 */
const routeDayAmendment =
  (collectionGroupId: string, days: readonly ServiceDay[]) =>
  (body: RouteSchemeCreate, predecessor: RouteScheme): RouteSchemeCreate => {
    const at = predecessor.collectionGroups.findIndex((group) => group.id === collectionGroupId)
    const groups = (body.collectionGroups ?? []).map((group, index) => (index === at ? { ...group, days: [...days] } : group))
    return { ...body, collectionGroups: groups, serviceDays: [...serviceDaysAfter(body.frequency as RecurrenceFrequency, body.serviceDays as ServiceDay[], groups as { days: ServiceDay[] }[])] }
  }

/**
 * The amendment an approved vehicle change makes to the scheme's next
 * version: the group, found as the route-day change finds it, runs with the
 * proposed vehicle, and with the proposed driver where one is named, else
 * its own.
 */
const vehicleAmendment =
  (collectionGroupId: string, vehicleId: string, driverId: string | null) =>
  (body: RouteSchemeCreate, predecessor: RouteScheme): RouteSchemeCreate => {
    const at = predecessor.collectionGroups.findIndex((group) => group.id === collectionGroupId)
    return { ...body, collectionGroups: (body.collectionGroups ?? []).map((group, index) => (index === at ? { ...group, vehicleId, ...(driverId === null ? {} : { driverId }) } : group)) }
  }

/**
 * The amendment an approved stop-set change makes to the scheme's next
 * version: the group, found as the others find it, picks the proposed
 * containers in the proposed order.
 */
const stopsAmendment =
  (collectionGroupId: string, containerIds: readonly string[]) =>
  (body: RouteSchemeCreate, predecessor: RouteScheme): RouteSchemeCreate => {
    const at = predecessor.collectionGroups.findIndex((group) => group.id === collectionGroupId)
    return { ...body, collectionGroups: (body.collectionGroups ?? []).map((group, index) => (index === at ? { ...group, containerIds: [...containerIds] } : group)) }
  }

/** What approving a proposal amends the scheme's next version by. */
function amendmentOf(proposal: Proposal) {
  switch (proposal.kind) {
    case "route-day-change":
      return routeDayAmendment(proposal.collectionGroupId, proposal.serviceDays)
    case "vehicle-change":
      return vehicleAmendment(proposal.collectionGroupId, proposal.vehicleId, proposal.driverId)
    case "stop-set-change":
      return stopsAmendment(proposal.collectionGroupId, proposal.containerIds)
  }
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export type ActivityRouteOptions = { now?: () => Date; jobs: JobSender }

export function serviceProviderActivityRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date(), jobs }: ActivityRouteOptions) {
  /**
   * A command's route: the row locked and read through the caller's reach,
   * the move judged by the domain (the kind, the status, then the side), and
   * the row closed by the caller with its reason; `apply` runs between the
   * judgement and the write, an approval's change.
   */
  const close = async (tx: Tx, principal: Principal, id: string, command: ActivityCommand, reason: string | null, apply?: (row: Row) => Promise<string>): Promise<Row> => {
    await lockRow(tx, serviceProviderActivity, { companyId: principal.companyId, id })
    const current = await findActivity(tx, principal, id)
    if (current === undefined) throw noSuchActivity(id)
    const move = closesWith({ number: current.number, kind: current.kind as ActivityKind, status: current.status as ActivityStatus }, command, sideOf(principal))
    if (!move.ok) throw problem(move.status, { detail: move.detail })
    const successorSchemeId = apply === undefined ? null : await apply(current)
    const [row] = await tx
      .update(serviceProviderActivity)
      .set({ status: move.to, closedBy: principal.user.id, closedAt: now(), closeReason: reason, ...(successorSchemeId === null ? {} : { successorSchemeId }) })
      .where(and(eq(serviceProviderActivity.companyId, principal.companyId), eq(serviceProviderActivity.id, id)))
      .returning(columns)
    return row
  }

  /**
   * What approving a proposal applies: the scheme's grant asked, the proposal
   * judged again against the scheme as it stands now, every refusal a 409,
   * and the next version written from its day with the change amended in.
   * A refusal of the successor's own — a body field it would hold the
   * approver to — is the approval's 409 in the same sentence.
   */
  const applyProposal = async (tx: Tx, principal: Principal, row: Row): Promise<string> => {
    requireAllowed(principal.grants, SCHEMES, "create")
    const proposal = await proposalOf(tx, principal.companyId, row)
    // The approver is the office's, so the crew is held to the project and the group alone: whose fleet it is was judged when the proposal was opened.
    const scope = { companyId: principal.companyId, projectId: row.projectId, serviceProviderId: row.serviceProviderId, provider: await providerName(tx, principal.companyId, row.serviceProviderId), ownFleet: null }
    const judged = await judgeProposal(tx, scope, proposal, now)
    if ("status" in judged) throw problem(409, { detail: `${activityLabel(row.number)} cannot be approved: ${judged.message}` })
    try {
      const succession = await writeSuccessor(tx, principal, { jobs, now }, proposal.routeSchemeId, proposal.effectiveFrom, amendmentOf(proposal))
      return succession.successor.id
    } catch (error) {
      // The successor's 400s hold a body the approver never sent, and its 409s a scheme the approver did not name: each is the approval's 409, in the successor's sentence.
      if (error instanceof ProblemError && (error.status === 400 || error.status === 409))
        throw problem(409, { detail: `${activityLabel(row.number)} cannot be approved: ${error.body.errors?.map((issue) => issue.message).join("; ") ?? error.body.detail}`, errors: error.body.errors })
      throw error
    }
  }

  const command = (name: ActivityCommand, summary: string, description: string, conflict: string) =>
    describeRoute({
      operationId: `${name}ServiceProviderActivity`,
      summary,
      description,
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("The activity as it now stands.", ServiceProviderActivity),
        400: describeProblem(name === "reject" ? "The path does not hold an id, or the body gives no reason or names a member it does not have." : "The path does not hold an id, or the body names a member it does not have."),
        401: describeProblem("No usable token (see WWW-Authenticate)."),
        403: describeProblem(`No active account here, the caller's role does not allow \`edit\` on \`${MODULE}\`, or the caller's side does not give this command: the office decides a proposal and closes its follow-ups.`),
        404: describeProblem("No activity with that id this account reaches."),
        409: describeProblem(conflict),
      },
    })

  const closing = (name: Exclude<ActivityCommand, "approve" | "reject">, summary: string, description: string) =>
    [
      command(name, summary, description, "The activity is not of a kind the command takes, or is not where the command takes it from, in the domain's sentence."),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ActivityClose),
    ] as const

  return new Hono<AuthEnv>()
    .get(
      "/service-provider-activities",
      describeRoute({
        operationId: "listServiceProviderActivities",
        summary: "The service provider activities",
        description:
          "One page of the Activities the caller reaches, oldest first (ids are time-ordered): an office account's are those of the projects it works in, a provider's account's those of its own provider, in whatever project. `projectId` narrows it to one project — for an office account one it works in, naming another is refused — and `serviceProviderId`, `kind` and `status` narrow it further. Overdue is a reading of an open follow-up's `dueOn`, never a status. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of activities.", ActivityPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is not of the vocabulary, or `projectId` is not a project this office account works in."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ServiceProviderActivityListQuery),
      async (c) => {
        const { limit, cursor, projectId, serviceProviderId, kind, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined && providerIdOf(principal) === null) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(serviceProviderActivity)
          .where(
            and(
              reach(principal),
              projectId === undefined ? undefined : eq(serviceProviderActivity.projectId, projectId),
              serviceProviderId === undefined ? undefined : eq(serviceProviderActivity.serviceProviderId, serviceProviderId),
              kind === undefined ? undefined : eq(serviceProviderActivity.kind, kind),
              status === undefined ? undefined : eq(serviceProviderActivity.status, status),
              after === undefined ? undefined : gt(serviceProviderActivity.id, after),
            ),
          )
          .orderBy(asc(serviceProviderActivity.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: await answers(c.get("tx"), principal.companyId, items), nextCursor })
      },
    )
    .post(
      "/service-provider-activities",
      describeRoute({
        operationId: "createServiceProviderActivity",
        summary: "Open a service provider activity",
        description:
          "Opens an Activity of its kind, shaped by it: a `route-day-change` — a proposal, `pending-approval` — names a scheme of the project, one of its collection groups, the days the group should run on and the first day they apply from (`effectiveFrom`, tomorrow on the project's clock at the earliest and inside the scheme's period); a `vehicle-change` — a proposal too — the same group, the powered vehicle of the project it should run with, optionally a driver of the project, and the first day, the vehicle or the driver moved, and from a provider's account both of its own fleet; a `stop-set-change` — a proposal too — the same of a group that picks its stops (a rule group's are its rule's), the containers of the project it should run on in stop order, each once, and the first day, the list or its order moved; a `compliance-follow-up`, `open`, its due day; a `coordination-note`, `open`, nothing more. Every kind names its project, its provider, a subject and optionally a body and the Service Area it is about, one the provider is or was assigned in the project. A provider's account opens a proposal or a note for its own provider alone, in a project where its provider holds an award in force today; a compliance follow-up is the office's to raise (403). The office opens any kind for a provider that is or was assigned a Service Area in the project. A proposal's provider serves the scheme on `effectiveFrom` — a Service Area assigned to it then holds the scheme's planning area — whichever side opens it (409 otherwise), the scheme is not archived and the group runs on some day (409). The server numbers it, the company's next, and mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The activity as it was opened.", ServiceProviderActivity),
          400: describeProblem(
            "The body is missing a field its kind needs, names a member the server owns or its kind does not carry, a value outside the vocabulary, a project the caller may not name, a provider not the caller's own (a provider's account) or never assigned in the project (the office), a Service Area not the provider's in the project, a scheme not the project's, a group not the scheme's, the days the group runs on already, or a first day before tomorrow or outside the scheme's period.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, the caller's role does not allow \`create\` on \`${MODULE}\`, or a provider's account opens a compliance follow-up.`),
          409: describeProblem("The proposal's scheme is archived, its group is parked, or its provider does not serve the scheme on the day it would apply from."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ServiceProviderActivityCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const refusedSide = createRefusal(body.kind, sideOf(principal))
        if (refusedSide !== null) throw problem(403, { detail: refusedSide })
        await requireReachedProject(tx, principal, body.projectId, now)
        const provider = await requireProviderOf(tx, principal, body.projectId, body.serviceProviderId)
        const scope = { companyId: principal.companyId, projectId: body.projectId, serviceProviderId: body.serviceProviderId, provider, ownFleet: providerIdOf(principal) }
        await requireAward(tx, scope, body.serviceAreaId)
        if (body.kind === "route-day-change" || body.kind === "vehicle-change" || body.kind === "stop-set-change") {
          const proposal: Proposal = body.kind === "vehicle-change" ? { ...body, driverId: body.driverId ?? null } : body
          const judged = await judgeProposal(tx, scope, proposal, now)
          if ("status" in judged) refuseProposal(judged)
        }
        const proposed = body.kind === "route-day-change" || body.kind === "vehicle-change" || body.kind === "stop-set-change" ? body : undefined
        // The company's row first, so two opens take the next number one after the other; a key share, so the company's children still insert beside it.
        await tx.select({ id: company.id }).from(company).where(eq(company.id, principal.companyId)).limit(1).for("no key update")
        const [{ highest }] = await tx.select({ highest: max(serviceProviderActivity.number) }).from(serviceProviderActivity).where(eq(serviceProviderActivity.companyId, principal.companyId))
        const [row] = await tx
          .insert(serviceProviderActivity)
          .values({
            id: newId(),
            companyId: principal.companyId,
            projectId: body.projectId,
            number: (highest ?? 0) + 1,
            kind: body.kind,
            status: isProposal(body.kind) ? "pending-approval" : "open",
            serviceProviderId: body.serviceProviderId,
            serviceAreaId: body.serviceAreaId ?? null,
            subject: body.subject,
            body: body.body ?? null,
            dueOn: body.kind === "compliance-follow-up" ? body.dueOn : null,
            routeSchemeId: proposed?.routeSchemeId ?? null,
            collectionGroupId: proposed?.collectionGroupId ?? null,
            serviceDays: body.kind === "route-day-change" ? [...body.serviceDays] : null,
            effectiveFrom: proposed?.effectiveFrom ?? null,
            vehicleId: body.kind === "vehicle-change" ? body.vehicleId : null,
            driverId: body.kind === "vehicle-change" ? (body.driverId ?? null) : null,
            openedBy: principal.user.id,
          })
          .returning(columns)
        if (body.kind === "stop-set-change") await writeContainers(tx, row, principal.companyId, body.containerIds)
        return created(c, "/service-provider-activities", await answer(tx, principal.companyId, row))
      },
    )
    .get(
      "/service-provider-activities/:id",
      describeRoute({
        operationId: "getServiceProviderActivity",
        summary: "One service provider activity",
        description: "One Activity the caller reaches: of a project it works in for an office account, of its own provider for a provider's account. Any other is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The activity.", ServiceProviderActivity),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No activity with that id this account reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findActivity(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchActivity(id)
        return c.json(await answer(c.get("tx"), c.get("principal").companyId, row))
      },
    )
    .patch(
      "/service-provider-activities/:id",
      describeRoute({
        operationId: "patchServiceProviderActivity",
        summary: "Correct a service provider activity",
        description:
          "Corrects an Activity while it is open — a proposal pending approval, any other kind open — in its subject, body or Service Area, a follow-up's due day, or a proposal's days, crew, containers — replaced whole — and first day; at least one must be given, and a member its kind does not carry is refused at its field. The kind, the provider, the project and a proposal's scheme and group are its own: another group's change is another proposal. The side that may open the kind corrects it: a follow-up is the office's. A proposal is judged again as it would stand, as an open judges it. A closed Activity is not corrected (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The activity as it now stands.", ServiceProviderActivity),
          400: describeProblem("The path does not hold an id, the patch is empty, names a member the caller does not own or the kind does not carry, a Service Area not the provider's in the project, the days the group runs on already, or a first day before tomorrow or outside the scheme's period."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, the caller's role does not allow \`edit\` on \`${MODULE}\`, or a provider's account corrects the office's follow-up.`),
          404: describeProblem("No activity with that id this account reaches."),
          409: describeProblem("The activity is closed, or the proposal as it would stand is about an archived scheme or a parked group, or a scheme its provider does not serve on the day."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceProviderActivityPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, serviceProviderActivity, { companyId: principal.companyId, id })
        const current = await findActivity(tx, principal, id)
        if (current === undefined) throw noSuchActivity(id)
        const kind = current.kind as ActivityKind
        if (!OPEN_STATUSES.includes(current.status as ActivityStatus)) throw problem(409, { detail: `${activityLabel(current.number)} is ${current.status.replace("-", " ")}: only an open activity is corrected` })
        if (!correctedBy(kind, sideOf(principal))) throw problem(403, { detail: createRefusal(kind, sideOf(principal)) ?? undefined })
        const carried: Readonly<Record<ActivityKind, readonly string[]>> = {
          "route-day-change": ["serviceDays", "effectiveFrom"],
          "vehicle-change": ["vehicleId", "driverId", "effectiveFrom"],
          "stop-set-change": ["containerIds", "effectiveFrom"],
          "compliance-follow-up": ["dueOn"],
          "coordination-note": [],
        }
        const foreign = (["dueOn", "serviceDays", "effectiveFrom", "vehicleId", "driverId", "containerIds"] as const).filter((member) => patch[member] !== undefined && !carried[kind].includes(member))
        if (foreign.length > 0) throw invalidRequest("body", foreign.map((path) => ({ path, message: KIND_CARRIES_NOT })))
        const provider = await providerName(tx, principal.companyId, current.serviceProviderId)
        const scope = { companyId: principal.companyId, projectId: current.projectId, serviceProviderId: current.serviceProviderId, provider, ownFleet: providerIdOf(principal) }
        await requireAward(tx, scope, patch.serviceAreaId)
        if (isProposal(kind) && (patch.serviceDays !== undefined || patch.effectiveFrom !== undefined || patch.vehicleId !== undefined || patch.driverId !== undefined || patch.containerIds !== undefined)) {
          // The proposal as the correction would leave it, judged as an open judges it.
          const stored = await proposalOf(tx, principal.companyId, current)
          const effectiveFrom = patch.effectiveFrom ?? stored.effectiveFrom
          const proposal: Proposal =
            stored.kind === "route-day-change"
              ? { ...stored, effectiveFrom, serviceDays: patch.serviceDays ?? stored.serviceDays }
              : stored.kind === "vehicle-change"
                ? { ...stored, effectiveFrom, vehicleId: patch.vehicleId ?? stored.vehicleId, driverId: patch.driverId === undefined ? stored.driverId : patch.driverId }
                : { ...stored, effectiveFrom, containerIds: patch.containerIds ?? stored.containerIds }
          const judged = await judgeProposal(tx, scope, proposal, now)
          if ("status" in judged) refuseProposal(judged)
        }
        const { containerIds, ...own } = patch
        const [row] = await tx
          .update(serviceProviderActivity)
          .set({ ...own, ...(patch.serviceDays === undefined ? {} : { serviceDays: [...patch.serviceDays] }), ...stamp() })
          .where(and(eq(serviceProviderActivity.companyId, principal.companyId), eq(serviceProviderActivity.id, id)))
          .returning(columns)
        if (containerIds !== undefined) await writeContainers(tx, row, principal.companyId, containerIds)
        return c.json(await answer(tx, principal.companyId, row))
      },
    )
    .post(
      "/service-provider-activities/:id/approve",
      command(
        "approve",
        "Approve a proposal, and apply it",
        "Approves a proposal pending approval — the office's alone (403 from a provider's account) — and applies it in the same transaction, which takes `create` on `route-studio.schemes` beside the decision's `edit` (403 otherwise). A `route-day-change` writes the scheme's next version from the proposal's `effectiveFrom`, as `POST /route-schemes/{id}/successor` writes one, with the proposal's group running on its proposed days and the scheme serving the days its groups then run on — or, for a `vehicle-change`, the group running with the proposed vehicle, and the proposed driver where one is named, or, for a `stop-set-change`, the group picking the proposed containers in their order: the version is held to every rule a create is held to, the predecessor's period is cut at the day and its routes from it ended as a successor ends them, and a validated version is planned. The proposal is judged again first against the scheme as it stands. Whatever refuses — a day now past, the scheme archived, its provider no longer serving it, a route of it dispatched on or after the day, or a rule of the new version — refuses the approval (409, the sentence saying why) and leaves the proposal pending. The approved activity names the version it wrote, `successorSchemeId`, and who approved it; `reason` is kept as the approval's note.",
        "The activity is not a proposal or not pending approval, or its change cannot be applied: the sentence says why, and the proposal stays pending.",
      ),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ActivityClose),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await close(tx, principal, c.req.valid("param").id, "approve", c.req.valid("json").reason ?? null, (current) => applyProposal(tx, principal, current))
        return c.json(await answer(tx, principal.companyId, row))
      },
    )
    .post(
      "/service-provider-activities/:id/reject",
      command("reject", "Reject a proposal", "Rejects a proposal pending approval — the office's alone (403 from a provider's account) — with the reason its provider reads, which is required. Nothing is applied.", "The activity is not a proposal or not pending approval."),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ActivityReject),
      async (c) => c.json(await answer(c.get("tx"), c.get("principal").companyId, await close(c.get("tx"), c.get("principal"), c.req.valid("param").id, "reject", c.req.valid("json").reason))),
    )
    .post(
      "/service-provider-activities/:id/withdraw",
      ...closing("withdraw", "Withdraw a proposal", "Withdraws a proposal pending approval: its provider's account, or the office on its behalf. Nothing is applied; `reason` is kept where given."),
      async (c) => c.json(await answer(c.get("tx"), c.get("principal").companyId, await close(c.get("tx"), c.get("principal"), c.req.valid("param").id, "withdraw", c.req.valid("json").reason ?? null))),
    )
    .post(
      "/service-provider-activities/:id/complete",
      ...closing("complete", "Complete an activity", "Completes an open compliance follow-up — the office's alone (403 from a provider's account) — or an open coordination note, which either side completes. `reason` is kept where given."),
      async (c) => c.json(await answer(c.get("tx"), c.get("principal").companyId, await close(c.get("tx"), c.get("principal"), c.req.valid("param").id, "complete", c.req.valid("json").reason ?? null))),
    )
    .post(
      "/service-provider-activities/:id/cancel",
      ...closing("cancel", "Cancel a compliance follow-up", "Cancels an open compliance follow-up — the office's alone (403 from a provider's account). `reason` is kept where given."),
      async (c) => c.json(await answer(c.get("tx"), c.get("principal").companyId, await close(c.get("tx"), c.get("principal"), c.req.valid("param").id, "cancel", c.req.valid("json").reason ?? null))),
    )
}
