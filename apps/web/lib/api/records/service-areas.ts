// Service areas and their assignments on the prototype's records (Issue #186,
// slice 11 of #81, for #148): the award (`@waste/contracts/service-areas`,
// routes apps/api/src/routes/service-areas.ts) and the provider holding it
// over a period, as the two kinds of `service-providers.service-areas` — the
// module the API grants `/service-area-assignments` under. The contracts are
// imported as types only, so no zod reaches the bundle.
//
// An area is the set of planning areas it covers and the waste fractions it
// is for, by web id on the record (`zoneIds`, the key the map's coverage
// reads, and `wasteFractionIds`) and by server id on the wire. A drawn
// polygon is a selection mechanism only (#127): it is never persisted, and
// the map draws an area as its planning areas' boundaries. An area with no
// planning area is refused before the API sees it — it would reach no route.
// Its code is the contract's and set once; an edit patches the name, the
// boundary text, the notes and the period, then replaces a moved set whole
// through its own `PUT`, a refusal midway showing the row as the server then
// holds it (`PartialWrite`). No status on the wire: the record's is a
// reading of its period on the project's day.
//
// The areas are read with every assignment, so an area names the provider
// holding it today; an area a write answers names it from the assignments
// the store holds. An assignment is created under its area and moves only its
// notes and its end: a transfer ends one and adds another. The first
// assignment rides on the area's create when the form names a provider.
//
// Ids, rule (b) of #81's plan closing with this slice: `service-area-<uuid>`
// and `assignment-<uuid>`; no fixture lends its id.
import type { ServiceArea, ServiceAreaAssignment, ServiceAreaCreated, ServiceAreaDetail } from "@waste/contracts/service-areas"
import { splitList } from "@waste/domain/record-values"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS, masterDataKindOf } from "@/lib/data/master-data-kinds"
import { ASSIGNMENT_PREFIX, ASSIGNMENT_RECORD_KIND, isAssignmentRecord, isServiceAreaRecord, periodReading, SERVICE_AREA_PREFIX, SERVICE_AREA_RECORD_KIND, SERVICE_AREAS_MODULE } from "@/lib/data/provider-money"

import { create, get, listAll, patch, put } from "../client"
import { inheritedPresentation, isLocalRefusal, PartialWrite, patchOf, stampFacts, typed, webIdOf, type Client, type LocalRefusal, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { serviceProviderAdapter } from "./organisation"
import { dayIn, firstDayOut, lastDayIn, planningAreaAdapter } from "./planning"
import { projectMoved, projectServerIdOf, referenced, refusal } from "./places"
import { nameVia, referencedServerId, webIdVia } from "./references"

const AREA_PREFIX = "area"
const PROVIDER_PREFIX = "service-provider"
const FRACTION_PREFIX = MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix

/** What an award naming no planning area is told: it is the planning areas it covers, and with none it reaches no route. */
export const NO_PLANNING_AREA = "A service area is the planning areas it covers: pick at least one"
const CODE_SET_ONCE = "An award keeps its code: the contract spells it"
const TRANSFER = "A transfer ends this assignment and adds another"

/** An area as the module reads it: the wire's, with the assignments the list read or the detail carries, or the first one a create answered. */
export type ServiceAreaResource = (ServiceArea | ServiceAreaDetail | ServiceAreaCreated) & { assignments?: readonly ServiceAreaAssignment[] }

/** The record's project's day: what a period is read on. */
function projectDay(projectServerId: string, context: MappingContext): string {
  const project = context.resolve.byServerId(projectServerId)
  return dayIn(context.now ?? new Date(), project === undefined ? undefined : typed(project, "timezone"))
}

const periodLabel = (validFrom: string, validTo: string | null) => `${validFrom} – ${validTo === null ? "open" : lastDayIn(validTo)}`

/** The ids a multiselect names, each held to its kind: the server ids, or a refusal naming the field. */
function setOf(record: BusinessRecord, key: string, prefix: string, owns: (named: BusinessRecord) => boolean, refused: string, context: MappingContext): string[] | LocalRefusal {
  const ids: string[] = []
  for (const webId of splitList(typed(record, key) ?? "")) {
    const serverId = referencedServerId(webId, prefix, context, { owns })
    if (serverId === undefined) return refusal(key, refused)
    ids.push(serverId)
  }
  return ids
}

const planningAreasOf = (record: BusinessRecord, context: MappingContext) => setOf(record, "zoneIds", AREA_PREFIX, planningAreaAdapter.owns, "Pick planning areas the API holds", context)
const fractionsOf = (record: BusinessRecord, context: MappingContext) => setOf(record, "wasteFractionIds", FRACTION_PREFIX, (named) => masterDataKindOf(named) === "waste-fraction", "Pick waste fractions the API holds", context)

const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",")

/** The provider holding the area on the day, by name and web id: from the assignments the resource carries, else from the ones the store holds. */
function holderOf(area: ServiceAreaResource, areaWebId: string, day: string, context: MappingContext): { name: string; webId?: string } | undefined {
  const carried = area.assignments ?? ("assignment" in area && area.assignment !== null ? [area.assignment] : undefined)
  if (carried !== undefined) {
    const current = carried.find((assignment) => periodReading(assignment.validFrom, assignment.validTo, day) === "Active")
    return current === undefined ? undefined : { name: nameVia(context, PROVIDER_PREFIX, current.serviceProviderId), webId: webIdVia(context, PROVIDER_PREFIX, current.serviceProviderId) }
  }
  const held = context.resolve.find((record) => isAssignmentRecord(record) && record.status === "Active" && typed(record, "serviceAreaId") === areaWebId)
  const name = held?.facts["Service provider"]
  return name === undefined ? undefined : { name, webId: held === undefined ? undefined : typed(held, "serviceProviderId") }
}

/** What the record says the area's patchable fields are, as the wire spells them. */
function areaFields(record: BusinessRecord) {
  const lastDay = typed(record, "validTo")
  return {
    name: typed(record, "areaName") ?? record.name,
    boundaryText: typed(record, "boundary"),
    notes: typed(record, "notes") ?? null,
    validFrom: typed(record, "validFrom"),
    validTo: lastDay === undefined ? null : firstDayOut(lastDay),
  }
}

/** What an area's edit carries: the patch, and each set to replace whole. */
type AreaWrite = { patch?: object; planningAreaIds?: { ids: string[] }; wasteFractionIds?: { ids: string[] } }

export const serviceAreaAdapter: ResourceAdapter<ServiceAreaResource> = {
  prefix: SERVICE_AREA_PREFIX,
  owns: isServiceAreaRecord,
  // No status on the wire: the record's is a reading of its period.
  statuses: undefined,
  list: async (client) => {
    const [areas, assignments] = await Promise.all([listAll<ServiceArea>(client, "/service-areas"), listAll<ServiceAreaAssignment>(client, "/service-area-assignments")])
    return areas.map((area) => ({ ...area, assignments: assignments.filter((assignment) => assignment.serviceAreaId === area.id) }))
  },
  read: (client, serverId) => get<ServiceAreaDetail>(client, `/service-areas/${serverId}`),
  toRecord: (area, context) => {
    const id = webIdOf(SERVICE_AREA_PREFIX, area.id)
    const project = referenced(context, "project", area.projectId)
    const day = projectDay(area.projectId, context)
    const zones = area.planningAreaIds.map((serverId) => ({ id: webIdVia(context, AREA_PREFIX, serverId), name: nameVia(context, AREA_PREFIX, serverId) }))
    const fractions = area.wasteFractionIds.map((serverId) => ({ id: webIdVia(context, FRACTION_PREFIX, serverId), name: nameVia(context, FRACTION_PREFIX, serverId) }))
    const holder = holderOf(area, id, day, context)
    const lastDay = area.validTo === null ? undefined : lastDayIn(area.validTo)
    const fractionNames = fractions.map((fraction) => fraction.name).join(", ")
    return {
      id,
      name: area.name,
      context: fractionNames === "" ? area.code : `${area.code} · ${fractionNames}`,
      status: periodReading(area.validFrom, area.validTo, day),
      ...inheritedPresentation(undefined),
      ...stampFacts(area, context.now),
      value: periodLabel(area.validFrom, area.validTo),
      description: area.boundaryText,
      facts: {
        Code: area.code,
        Project: project.name ?? project.webId,
        ...(holder === undefined ? {} : { "Service provider": holder.name }),
        "Planning areas": zones.map((zone) => zone.name).join(" · "),
        ...(fractionNames === "" ? {} : { "Waste fractions": fractionNames }),
        Boundary: area.boundaryText,
        ...(area.notes === null ? {} : { Notes: area.notes }),
        "Valid from": area.validFrom,
        ...(lastDay === undefined ? {} : { "Valid to": lastDay }),
      },
      related: [...(holder === undefined ? [] : [holder.name]), ...zones.map((zone) => zone.name)],
      // The holder in force: the provider page lists the areas it holds by it.
      ...(holder?.webId === undefined ? {} : { serviceProviderId: holder.webId }),
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: SERVICE_AREA_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        areaCode: area.code,
        areaName: area.name,
        boundary: area.boundaryText,
        ...(area.notes === null ? {} : { notes: area.notes }),
        zoneIds: zones.map((zone) => zone.id).join(","),
        wasteFractionIds: fractions.map((fraction) => fraction.id).join(","),
        validFrom: area.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const code = typed(record, "areaCode")
    if (code === undefined) return refusal("areaCode", "An award needs the code its contract spells")
    const planningAreaIds = planningAreasOf(record, context)
    if (isLocalRefusal(planningAreaIds)) return planningAreaIds
    if (planningAreaIds.length === 0) return refusal("zoneIds", NO_PLANNING_AREA)
    const wasteFractionIds = fractionsOf(record, context)
    if (isLocalRefusal(wasteFractionIds)) return wasteFractionIds
    const fields = areaFields(record)
    if (fields.boundaryText === undefined) return refusal("boundary", "Give the boundary as the contract describes it")
    if (fields.validFrom === undefined) return refusal("validFrom", "An award needs the first day it is in force")
    const providerWebId = typed(record, "serviceProviderId")
    const serviceProviderId = providerWebId === undefined ? undefined : referencedServerId(providerWebId, PROVIDER_PREFIX, context, { owns: serviceProviderAdapter.owns })
    if (providerWebId !== undefined && serviceProviderId === undefined) return refusal("serviceProviderId", "Pick a service provider the API holds")
    return {
      projectId,
      code,
      name: fields.name,
      boundaryText: fields.boundaryText,
      ...(fields.notes === null ? {} : { notes: fields.notes }),
      planningAreaIds,
      wasteFractionIds,
      validFrom: fields.validFrom,
      ...(fields.validTo === null ? {} : { validTo: fields.validTo }),
      // The first assignment runs for the award's period: the API's default when the body names none.
      ...(serviceProviderId === undefined ? {} : { assignment: { serviceProviderId } }),
    }
  },
  toPatchBody: (before, after, context) => {
    if (projectMoved(before, after)) return refusal("projectId", "An award stays in its project")
    if (typed(after, "areaCode") !== typed(before, "areaCode")) return refusal("areaCode", CODE_SET_ONCE)
    const zones = planningAreasOf(after, context)
    if (isLocalRefusal(zones)) return zones
    if (zones.length === 0) return refusal("zoneIds", NO_PLANNING_AREA)
    const fractions = fractionsOf(after, context)
    if (isLocalRefusal(fractions)) return fractions
    const wasZones = planningAreasOf(before, context)
    const wasFractions = fractionsOf(before, context)
    const write: AreaWrite = {}
    const fields = patchOf(before, after, areaFields)
    if (fields !== null) write.patch = fields
    if (isLocalRefusal(wasZones) || !sameSet(wasZones, zones)) write.planningAreaIds = { ids: zones }
    if (isLocalRefusal(wasFractions) || !sameSet(wasFractions, fractions)) write.wasteFractionIds = { ids: fractions }
    return Object.keys(write).length === 0 ? null : write
  },
  create: (client, body) => create<ServiceAreaCreated>(client, "/service-areas", body).then((created) => created.body),
  // The patch, then each moved set replaced whole: a refusal after a request landed is a PartialWrite with the row as it then stands.
  update: async (client, serverId, body) => {
    const write = body as AreaWrite
    const path = `/service-areas/${serverId}`
    let row: ServiceArea | undefined
    const step = async (request: () => Promise<ServiceArea>) => {
      try {
        row = await request()
      } catch (error) {
        if (row !== undefined) throw new PartialWrite(error, row)
        throw error
      }
    }
    if (write.patch !== undefined) await step(() => patch<ServiceArea>(client, path, write.patch))
    if (write.planningAreaIds !== undefined) await step(() => put<ServiceArea>(client, `${path}/planning-areas`, write.planningAreaIds))
    if (write.wasteFractionIds !== undefined) await step(() => put<ServiceArea>(client, `${path}/waste-fractions`, write.wasteFractionIds))
    return row ?? (await get<ServiceArea>(client, path))
  },
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/** What an assignment's create carries: the area it is posted under, and the body the contract accepts. */
type AssignmentWrite = { serviceAreaId: string; body: unknown }

export const assignmentAdapter: ResourceAdapter<ServiceAreaAssignment> = {
  prefix: ASSIGNMENT_PREFIX,
  owns: isAssignmentRecord,
  statuses: undefined,
  list: (client) => listAll<ServiceAreaAssignment>(client, "/service-area-assignments"),
  toRecord: (assignment, context) => {
    // The area, loaded just before this row in the module's order.
    const area = context.resolve.byServerId(assignment.serviceAreaId)
    const areaWebId = area?.id ?? webIdOf(SERVICE_AREA_PREFIX, assignment.serviceAreaId)
    const code = area === undefined ? areaWebId : (typed(area, "areaCode") ?? area.name)
    const provider = referenced(context, PROVIDER_PREFIX, assignment.serviceProviderId)
    const providerName = provider.name ?? provider.webId
    const project = referenced(context, "project", assignment.projectId)
    const lastDay = assignment.validTo === null ? undefined : lastDayIn(assignment.validTo)
    return {
      id: webIdOf(ASSIGNMENT_PREFIX, assignment.id),
      name: `${code} · ${providerName}`,
      context: periodLabel(assignment.validFrom, assignment.validTo),
      status: periodReading(assignment.validFrom, assignment.validTo, projectDay(assignment.projectId, context)),
      ...inheritedPresentation(undefined),
      ...stampFacts(assignment, context.now),
      value: periodLabel(assignment.validFrom, assignment.validTo),
      description: `${providerName} holds ${area?.name ?? code}.`,
      facts: {
        "Service area": area?.name ?? code,
        "Service provider": providerName,
        ...(assignment.notes === null ? {} : { Notes: assignment.notes }),
        "Valid from": assignment.validFrom,
        ...(lastDay === undefined ? {} : { "Valid to": lastDay }),
      },
      related: [area?.name ?? code, providerName],
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: ASSIGNMENT_RECORD_KIND,
      submittedValues: {
        serviceAreaId: areaWebId,
        serviceProviderId: provider.webId,
        ...(assignment.notes === null ? {} : { notes: assignment.notes }),
        validFrom: assignment.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const areaWebId = typed(record, "serviceAreaId")
    const serviceAreaId = areaWebId === undefined ? undefined : referencedServerId(areaWebId, SERVICE_AREA_PREFIX, context, { owns: isServiceAreaRecord })
    if (serviceAreaId === undefined) return refusal("serviceAreaId", "Pick a service area the API holds")
    const providerWebId = typed(record, "serviceProviderId")
    const serviceProviderId = providerWebId === undefined ? undefined : referencedServerId(providerWebId, PROVIDER_PREFIX, context, { owns: serviceProviderAdapter.owns })
    if (serviceProviderId === undefined) return refusal("serviceProviderId", "Pick a service provider the API holds")
    const validFrom = typed(record, "validFrom")
    if (validFrom === undefined) return refusal("validFrom", "An assignment needs the first day it holds the area")
    // Left open, it ends with its award, as the form's hint says: the API refuses an open end under a bounded award.
    const area = context.resolve.find((candidate) => candidate.id === areaWebId)
    const lastDay = typed(record, "validTo") ?? (area === undefined ? undefined : typed(area, "validTo"))
    const notes = typed(record, "notes")
    const write: AssignmentWrite = {
      serviceAreaId,
      body: { serviceProviderId, ...(notes === undefined ? {} : { notes }), validFrom, ...(lastDay === undefined ? {} : { validTo: firstDayOut(lastDay) }) },
    }
    return write
  },
  toPatchBody: (before, after, context) => {
    const named = (record: BusinessRecord, key: string, prefix: string) => {
      const webId = typed(record, key)
      return webId === undefined ? undefined : (referencedServerId(webId, prefix, context) ?? webId)
    }
    if (named(before, "serviceProviderId", PROVIDER_PREFIX) !== named(after, "serviceProviderId", PROVIDER_PREFIX)) return refusal("serviceProviderId", TRANSFER)
    if (named(before, "serviceAreaId", SERVICE_AREA_PREFIX) !== named(after, "serviceAreaId", SERVICE_AREA_PREFIX)) return refusal("serviceAreaId", TRANSFER)
    if (typed(before, "validFrom") !== typed(after, "validFrom")) return refusal("validFrom", TRANSFER)
    return patchOf(before, after, (record) => {
      const lastDay = typed(record, "validTo")
      return { notes: typed(record, "notes") ?? null, validTo: lastDay === undefined ? null : firstDayOut(lastDay) }
    })
  },
  create: (client, body) => {
    const write = body as AssignmentWrite
    return create<ServiceAreaAssignment>(client, `/service-areas/${write.serviceAreaId}/assignments`, write.body).then((created) => created.body)
  },
  update: (client, serverId, body) => patch<ServiceAreaAssignment>(client, `/service-area-assignments/${serverId}`, body),
}

/** Service providers › Service Areas: the awards, then their assignments, which name their area through the rows loaded just before them. */
export const serviceAreasModule: ServerModule = { workspaceId: SERVICE_AREAS_MODULE.workspaceId, moduleId: SERVICE_AREAS_MODULE.moduleId, resources: [serviceAreaAdapter, assignmentAdapter] }

export type { Client }
