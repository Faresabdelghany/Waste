/**
 * Route Schemes — the Route Studio module every scheme surface reads: the
 * list, the scheme page, the wizard, the map's coverage, generation. The
 * module is defined in the Plan workspace's registry and shown in Route
 * Studio only (business-modules.ts), so this is the one place that spells
 * where the records live.
 */
import { schemeLicenceDay, type JudgedDay } from "@waste/domain/planning/checks"
import { editChangesGeneration, futureRefreshableRoutes, schemeAfterOneOff, schemeEditPolicy, SCHEME_EDIT_APPLICATION_OPTIONS, type SchemeEditApplication, type SchemeEditQuestion } from "@waste/domain/route-schemes/edit"
import { collectionGroupsOfRecord, collectionGroupsToValues, type CollectionGroup } from "@waste/domain/route-schemes/groups"
import { schemeGenerationRecorded } from "@waste/domain/route-schemes/lifecycle"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import { isIsoDate, serviceDaysFromValues } from "@waste/domain/route-schemes/recurrence"
import { isNoMatchIssue, type SchemeValidationResult } from "@waste/domain/route-schemes/validation"

import { typed } from "@/lib/api/records/adapter"
import type { ModuleState } from "@/lib/api/records/server-records"

import type { BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"

export const ROUTE_SCHEMES_MODULE = { workspaceId: "route-studio", moduleId: "schemes" } as const satisfies ModuleLocation

/**
 * "1 route", "1.5 routes", "0.3 routes": the guided setup's routes a week
 * (`draftRoutesPerWeek`, #280), an average over the recurrence's rotation and
 * so rarely whole, at one decimal — the singular for what reads as one.
 */
export function routesPerWeekLabel(count: number): string {
  const shown = Math.round(count * 10) / 10
  return `${shown.toLocaleString("en-GB")} route${shown === 1 ? "" : "s"}`
}

/**
 * The status a scheme edit asks the API for on the Pilot, where the API holds
 * the structural rules and generates the routes: the stored one — the web's
 * own validation never lowers a Validated scheme, the API's 409 speaks for
 * what it refuses — and Validated for a Draft the edit leaves without a
 * blocking issue (`issues` from the live validation; null where there is no
 * recurrence to judge), the browser path's rule (D31). So a Draft — one a
 * person drafted, or one an edit left a Draft before an edit became one
 * request (#205) — is validated again by the save that leaves it sound.
 */
export function schemeEditStatusOnApi(stored: string, issues: readonly string[] | null): string {
  return stored === "Draft" && issues !== null && issues.length === 0 ? "Validated" : stored
}

/**
 * The typed values a scheme is created with from a draft — both create
 * paths' (Guided Setup's draft, Quick create's form mapped onto the same
 * shape): the draft's fields under the form's ids and its groups in the one
 * group shape, the legacy single-assignment keys for one group running
 * every service day and the explicit JSON otherwise (D36). `groups` are the
 * draft's with their fleet names denormalized; `extraValues` are the quick
 * form's fields outside the draft, carried verbatim beneath. On the Pilot
 * the route-schemes adapter reads these back into the create body.
 */
export function schemeValuesOfDraft(data: GuidedSchemeData, groups: readonly CollectionGroup[], extraValues: BusinessFormValues = {}): BusinessFormValues {
  return {
    ...extraValues,
    schemeName: data.schemeName.trim(),
    projectId: data.projectId ?? "",
    planningAreaId: data.planningAreaId ?? "",
    wasteFraction: data.wasteFraction,
    serviceType: data.serviceType,
    frequency: data.frequency,
    weekRotation: data.frequency === "every-2-weeks" ? data.weekRotation : "",
    serviceDays: data.serviceDays.join(", "),
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    plannedStartTime: data.plannedStartTime,
    depotId: data.depotId ?? "",
    unloadingStationId: data.unloadingStationId ?? "",
    // Guided setup options (2026-09-16). Generation applies the holiday
    // policy through the same occurrence generator the wizard previewed with.
    holidayPolicy: data.holidayPolicy,
    createAs: data.createAs,
    // How a later edit of the running scheme applies (issue #38): step 5's
    // choice, or the quick form's; the edit-save planner reads it here.
    editPolicy: data.editPolicy,
    // One group covering every service day stores as the legacy
    // single-assignment shape; anything else stores the groups explicitly
    // (D36) — never both, the group list is the single source of truth.
    ...collectionGroupsToValues(groups, data.serviceDays),
  }
}

/** The timezone the project record of that id names, for its clock's day; undefined when it names none or is not among `projects`. */
export function timezoneOfProject(projects: readonly BusinessRecord[], projectId: string | undefined): string | undefined {
  const timezone = projects.find((record) => record.id === projectId)?.submittedValues?.timezone
  return typeof timezone === "string" && timezone !== "" ? timezone : undefined
}

/** Today on a project's clock, `YYYY-MM-DD`, as the API reads it; the browser's own day for a project that names no timezone the runtime knows. */
export function projectToday(timezone: string | undefined, now: Date = new Date()): string {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
    } catch {
      // An unknown zone reads as the browser's day, below.
    }
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

/**
 * The day a collection group's driver is held to their licence on where the
 * API holds it (#178): the scheme's first day or the project's today,
 * whichever is later (`schemeLicenceDay`, @waste/domain/planning/checks) —
 * a draft with no first day yet is judged on today.
 */
export function licenceDayOf(effectiveFrom: string, timezone: string | undefined, now: Date = new Date()): JudgedDay {
  const today = projectToday(timezone, now)
  return schemeLicenceDay(isIsoDate(effectiveFrom) ? effectiveFrom : today, today)
}

/** What stands in for the zero-match sentence where the API's containers are not placed. */
export const PREVIEW_UNPLACED = "The containers' places are not read, so this preview cannot count them; the API matches containers when it generates routes."

/**
 * Whether the preview had the API's containers placed (#207). On the
 * browser's own path, or with the containers still on fixtures, it always
 * has. On the Pilot, once the containers and every module their records are
 * read through (`CONTAINER_PLACE_MODULES`) are ready: one loading, failed or
 * not granted to the person's role leaves the preview with the fixtures'
 * containers, or with the API's standing nowhere because their place is
 * unread.
 */
export function containersPlaced(apiConfigured: boolean, containers: ModuleState | null, through: readonly (ModuleState | null)[]): boolean {
  if (!apiConfigured || containers === null) return true
  return [containers, ...through].every((state) => state === null || state.status === "ready")
}

/**
 * A scheme's validation where its containers may not be placed (#207): with
 * them placed, the web's own, the zero-match sentence blocking as in fixture
 * mode; without, the web's own less that one issue, which is no evidence
 * then, a notice standing in its place. Every other issue still blocks, and
 * the status is the web's rule over what is left.
 */
export function validationWhenUnplaced(result: SchemeValidationResult, placed: boolean): SchemeValidationResult & { notice: string | null } {
  if (placed || !result.issues.some(isNoMatchIssue)) return { ...result, notice: null }
  const issues = result.issues.filter((issue) => !isNoMatchIssue(issue))
  return { ...result, status: issues.length === 0 ? "Validated" : "Draft", issues, notice: PREVIEW_UNPLACED }
}

/** Why the Pilot's question offers "This collection only" disabled: the edit shapes more than one collection's routes can carry (#209). */
export const ONE_OFF_ONLY = "Only the planned start, the depot, the unloading station and a group's vehicle or driver can change for one collection; this edit changes more, so it applies to future collections."
/** Why it is disabled where no planned route the change reaches is left from today on. */
export const ONE_OFF_NO_ROUTE = "No planned route of the scheme from today on can take this change for one collection."
/** Why it is disabled where the groups a change reaches collect next on different days: one collection is one service date. */
export const ONE_OFF_SPLIT = "This change reaches groups whose next collections fall on different days: apply it to future collections, or change one group at a time."
/** Why it is disabled where the next collection's routes already stand as the edit has them. */
export const ONE_OFF_ALREADY = "The next collection's routes already stand as this edit has them."
/** Why a scheme whose stored policy is the one-off cannot work one out while the routes are not read. */
export const ONE_OFF_UNREAD = "Its next collection's routes are not read from the API."
/** What a scheme whose stored policy is the one-off says after the reason a shaping edit cannot apply so (#209). */
export const STORED_ONE_OFF = "This scheme applies a change to its next collection only: set its changes to apply to future collections, or to ask each time, to save this one."
/** What "This collection only" says it does on the Pilot. */
const ONE_OFF_DESCRIPTION = "Only the next collection's routes follow the edit: they are moved as the office moves a route, and later generation runs keep them as moved. The scheme itself keeps its current configuration."
/** Why a shaping edit that would ask is refused while the API's routes are not read. */
export const ROUTES_NOT_READ = "How this change applies is asked over the scheme's routes, which are not read from the API yet: save again once they are."

/** A value as the API reads it: JSON a form wrote (the groups, a rule by day) in one key order, so re-serialising it moves nothing. */
function canonical(value: string | boolean): string | boolean {
  if (typeof value !== "string" || !/^[[{]/.test(value.trim())) return value
  const sorted = (node: unknown): unknown =>
    Array.isArray(node) ? node.map(sorted) : node !== null && typeof node === "object" ? Object.fromEntries(Object.keys(node).sort().map((key) => [key, sorted((node as Record<string, unknown>)[key])])) : node
  try {
    return JSON.stringify(sorted(JSON.parse(value)))
  } catch {
    return value
  }
}

/**
 * Whether an edit shapes a collection as the API reads a scheme: its values
 * alone, the domain's rule (`editChangesGeneration`) over the JSON ones in
 * one key order. The facts are the edit form's display copies by field
 * label, which the API's record never carried and generation never reads.
 */
function shapesCollections(before: BusinessRecord, after: BusinessRecord): boolean {
  const values = (record: BusinessRecord) => Object.fromEntries(Object.entries(record.submittedValues ?? {}).map(([key, value]) => [key, canonical(value)]))
  return editChangesGeneration({ ...before, submittedValues: values(before) }, { ...after, facts: before.facts, submittedValues: values(after) })
}

/**
 * A command a one-off sends to one route (`ROUTE_COMMANDS`,
 * lib/api/records/routes.ts): the route, the command, and in its input the
 * fields the one-off moves alone — a field the input does not name the
 * command leaves as the route stands when it is sent.
 */
export type OneOffMove = { routeId: string; command: "assign" | "reschedule"; input: Record<string, string> }

/**
 * "This collection only" on the Pilot (#209): the `moves` on the routes of
 * the next collection, its service `date`, and the scheme to save beside them
 * — the stored one with the edit's rename or policy, null when the edit
 * carries neither.
 */
export type SchemeOneOff = { kind: "one-off"; date: string; moves: OneOffMove[]; scheme: BusinessRecord | null }

/** What a scheme edit does on the Pilot: ask how it applies, refuse it with the reason, save it — `following` the routes the save reaches when they are next generated — or move the next collection's routes alone. */
export type SchemeEditOnApi = { kind: "save"; following: number } | { kind: "ask"; question: SchemeEditQuestion } | { kind: "refuse"; message: string } | SchemeOneOff

/** The scheme's values a route copies and the office can move on it: the start by `reschedule`, the depot and the station by `assign`. */
const ONE_OFF_SCHEME_KEYS = ["plannedStartTime", "depotId", "unloadingStationId"] as const
/** A group's fleet, by id and by the names saved beside them: in the legacy shape the scheme's own keys. */
const ONE_OFF_GROUP_KEYS = ["vehicleId", "driverId", "vehicleName", "driverName"] as const
const ONE_OFF_LEGACY_KEYS = ["plannedVehicleId", "plannedDriverId"] as const
/** A value as a record carries it, "" for none. */
const valueOf = (record: Pick<BusinessRecord, "submittedValues">, key: string): string => typed(record, key) ?? ""

/** A scheme's `collectionGroups` JSON as stored, every member kept (the domain's reader keeps only the ones it knows), or null for the legacy shape. */
function storedGroups(values: Readonly<Record<string, string | boolean | undefined>>): Record<string, unknown>[] | null {
  const raw = values.collectionGroups
  if (typeof raw !== "string" || raw.trim() === "") return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null
  } catch {
    return null
  }
}

/** The edit with what one collection's routes can carry put back as it was stored: whatever it still shapes, they cannot. */
function withOneOffPutBack(before: BusinessRecord, after: BusinessRecord): BusinessRecord {
  const was = before.submittedValues ?? {}
  const values: Record<string, string | boolean> = { ...after.submittedValues }
  for (const key of [...ONE_OFF_SCHEME_KEYS, ...ONE_OFF_LEGACY_KEYS]) {
    const stored = was[key]
    if (stored === undefined) delete values[key]
    else values[key] = stored
  }
  const priorGroups = storedGroups(was)
  const groups = storedGroups(values)
  if (priorGroups !== null && groups !== null) {
    const prior = new Map(priorGroups.map((group) => [group.id, group]))
    values.collectionGroups = JSON.stringify(
      groups.map((group) => {
        const stored = prior.get(group.id)
        if (stored === undefined) return group
        const kept = { ...group }
        for (const key of ONE_OFF_GROUP_KEYS) {
          if (stored[key] === undefined) delete kept[key]
          else kept[key] = stored[key]
        }
        return kept
      }),
    )
  }
  return { ...after, submittedValues: values }
}

/** Whether two records' values are the same as the API reads them. */
function sameValues(a: BusinessRecord, b: BusinessRecord): boolean {
  const left = a.submittedValues ?? {}
  const right = b.submittedValues ?? {}
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => canonical(left[key] ?? "") === canonical(right[key] ?? ""))
}

/**
 * "This collection only" on the Pilot (#209): the next collection's routes
 * moved by the office's own commands — `reschedule` for the planned start,
 * `assign` for the depot, the unloading station and a group's vehicle or
 * driver — which the API holds against later generation runs; the scheme
 * keeps its shaping configuration, as the fixture path's one-off does
 * (`schemeAfterOneOff`). An edit that shapes anything else is `unavailable`
 * with `ONE_OFF_ONLY`: a route has no command for its days, its stops or its
 * provider. The next collection is the earliest service date among the scheme's
 * routes still `planned` and running on or after `today`, the project's day
 * (a collection shifted past a holiday runs after its service date), that the
 * change reaches — every group's for a scheme value, a group's own for its
 * fleet — and the moves are the reached routes on it, each naming only what
 * it changes on that route. None left is `ONE_OFF_NO_ROUTE`; a group's fleet
 * whose next collection is another day is `ONE_OFF_SPLIT`, since one
 * collection is one date and the change would be lost; routes that already
 * stand as edited are `ONE_OFF_ALREADY`. A legacy-shaped scheme's one group
 * holds every route.
 */
export function schemeOneOffOnApi(before: BusinessRecord, after: BusinessRecord, routes: readonly BusinessRecord[], today: string): SchemeOneOff | { kind: "unavailable"; message: string } {
  if (shapesCollections(before, withOneOffPutBack(before, after))) return { kind: "unavailable", message: ONE_OFF_ONLY }
  const schemeMoved = ONE_OFF_SCHEME_KEYS.filter((key) => valueOf(before, key) !== valueOf(after, key))
  const priorGroups = new Map(collectionGroupsOfRecord(before, serviceDaysFromValues(before.submittedValues)).map((group) => [group.id, group]))
  const groups = collectionGroupsOfRecord(after, serviceDaysFromValues(after.submittedValues))
  const fleetMoved = new Map<string, Record<string, string>>()
  for (const group of groups) {
    const prior = priorGroups.get(group.id)
    if (prior === undefined) continue
    const moved: Record<string, string> = {}
    if ((group.vehicleId ?? "") !== (prior.vehicleId ?? "")) moved.vehicleId = group.vehicleId ?? ""
    if ((group.driverId ?? "") !== (prior.driverId ?? "")) moved.driverId = group.driverId ?? ""
    if (Object.keys(moved).length > 0) fleetMoved.set(group.id, moved)
  }
  // An explicit group's web id is its routes' `collectionGroupId`; the legacy shape's one group holds them all.
  const legacy = groups.length === 1 && groups[0].implicit
  const groupOf = (route: BusinessRecord) => (legacy ? groups[0].id : valueOf(route, "collectionGroupId"))
  const reached = routes.filter(
    (route) =>
      typed(route, "schemeId") === before.id &&
      typed(route, "status") === "planned" &&
      (typed(route, "operatingDate") ?? valueOf(route, "serviceDate")) >= today &&
      (schemeMoved.length > 0 || fleetMoved.has(groupOf(route))),
  )
  if (reached.length === 0) return { kind: "unavailable", message: ONE_OFF_NO_ROUTE }
  const date = reached.map((route) => valueOf(route, "serviceDate")).sort()[0]
  const onDate = reached.filter((route) => valueOf(route, "serviceDate") === date).sort((a, b) => a.id.localeCompare(b.id))
  for (const groupId of fleetMoved.keys()) {
    if (onDate.some((route) => groupOf(route) === groupId)) continue
    return { kind: "unavailable", message: reached.some((route) => groupOf(route) === groupId) ? ONE_OFF_SPLIT : ONE_OFF_NO_ROUTE }
  }
  // Each route is told only what it changes there: a field it already has is no move, which the command would refuse.
  const changed = (route: BusinessRecord, wanted: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(wanted).filter(([key, value]) => valueOf(route, key) !== value))
  const moves: OneOffMove[] = []
  for (const route of onDate) {
    const start = schemeMoved.includes("plannedStartTime") ? changed(route, { plannedStartTime: valueOf(after, "plannedStartTime") }) : {}
    if (Object.keys(start).length > 0) moves.push({ routeId: route.id, command: "reschedule", input: start })
    const places = Object.fromEntries((["depotId", "unloadingStationId"] as const).filter((key) => schemeMoved.includes(key)).map((key) => [key, valueOf(after, key)]))
    const assigned = changed(route, { ...places, ...fleetMoved.get(groupOf(route)) })
    if (Object.keys(assigned).length > 0) moves.push({ routeId: route.id, command: "assign", input: assigned })
  }
  if (moves.length === 0) return { kind: "unavailable", message: ONE_OFF_ALREADY }
  const scheme = schemeAfterOneOff(before, after)
  return { kind: "one-off", date, moves, scheme: scheme.name === before.name && sameValues(scheme, before) ? null : scheme }
}

/**
 * What a scheme edit does on the Pilot (#179), the fixture path's
 * reconciliation (@waste/domain/route-schemes/edit,
 * `planSchemeEditReconciliation`) over the routes the API holds — `routes`,
 * or null while they are not read. An edit of a scheme that is not running
 * (a Draft, never generated) or that shapes no collection saves. Otherwise
 * the policy decides — the answer given, else the one stored before the edit,
 * so a save that switches "Ask each time" off still asks: "future" saves,
 * the one-off moves the next collection's routes where they can carry the
 * edit (`schemeOneOffOnApi`, #209) and is refused with the reason where they
 * cannot, and "ask" asks while planned routes of the scheme after `today`,
 * the project's day, can still follow the edit (`futureRefreshableRoutes`,
 * the rule the fixture path counts with: a dispatched route is frozen) and
 * saves when none can. The question names the collection the one-off would
 * move, else the earliest of those routes, and shows the one-off disabled
 * with its reason where it cannot. Without the routes read neither the
 * question nor the one-off can be worked out, so that edit is refused until
 * they are.
 */
export function schemeEditOnApi(before: BusinessRecord, after: BusinessRecord, routes: readonly BusinessRecord[] | null, today: string, apply?: SchemeEditApplication): SchemeEditOnApi {
  const following = () =>
    futureRefreshableRoutes(before.id, today, routes ?? [])
      .map((route) => typed(route, "serviceDate") ?? "")
      .sort()
  if (before.status === "Draft" || !schemeGenerationRecorded(before) || !shapesCollections(before, after)) return { kind: "save", following: 0 }
  const policy = apply ?? schemeEditPolicy(before.submittedValues)
  if (policy === "future") return { kind: "save", following: following().length }
  // A stored one-off says why this edit cannot apply so, then how to save it.
  const stored = apply === undefined
  if (routes === null) return { kind: "refuse", message: policy === "single" && stored ? `${ONE_OFF_UNREAD} ${STORED_ONE_OFF}` : ROUTES_NOT_READ }
  const oneOff = schemeOneOffOnApi(before, after, routes, today)
  if (policy === "single") {
    if (oneOff.kind === "one-off") return oneOff
    return { kind: "refuse", message: stored ? `${oneOff.message} ${STORED_ONE_OFF}` : oneOff.message }
  }
  const dates = following()
  if (dates.length === 0) return { kind: "save", following: 0 }
  return {
    kind: "ask",
    question: {
      futureRoutes: dates.length,
      nextCollectionDate: oneOff.kind === "one-off" ? oneOff.date : dates[0],
      options: {
        future: {
          label: SCHEME_EDIT_APPLICATION_OPTIONS.future.label,
          description: "The scheme is saved as edited, and its planned routes follow it when its routes are next generated — Generate on its page, or the nightly Plan Ahead run over the days it covers. Routes that are ready, active or completed stay as they are.",
        },
        single: { label: SCHEME_EDIT_APPLICATION_OPTIONS.single.label, description: ONE_OFF_DESCRIPTION, ...(oneOff.kind === "one-off" ? {} : { unavailable: oneOff.message }) },
      },
    },
  }
}
