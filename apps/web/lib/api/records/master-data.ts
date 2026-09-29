// Master data on the prototype's records (Issue #176, slice 2 of #81): the
// four catalogue resources — waste fractions, container types, service
// frequencies, vehicle types — as the rows of one module, `configure.master`,
// which Settings › Operations › Master data reads and writes and the fixture
// pickers point at. The wire shapes are the contracts'
// (`@waste/contracts/catalogue`, `vehicle-types`), imported as types so no
// zod reaches the bundle; the routes are apps/api/src/routes/catalogue.ts and
// vehicle-types.ts.
//
// Each kind is its own adapter; the module lists the container types before
// the vehicle types, so a vehicle type names its container types by the
// rows loaded just before it — through the store's resolver, so a container
// type made this session keeps the id the workspace minted. Which adapter
// owns a record is `masterDataKindOf` (lib/data/master-data-kinds.ts): the
// id's prefix, then the typed kind — the one rule the pane's pickers filter
// by too. No status is on the wire, so every move the module's lifecycle
// offers is refused, and a row reads "Effective", the module's word for a
// row in force. Nothing here lends a fixture's id: the module's fixtures are
// coarse master-data sets, not rows of these kinds, so a server row is
// `<prefix>-<uuid>` from the start.
//
// What the wire sets once, the adapter refuses to move: a fraction's or a
// vehicle type's key, a frequency's project, a row's kind. The rules a body
// is held to — a key's shape, a count, the contract's one cadence rule in
// the contract's own sentence — are lib/data/master-data.ts's, the same the
// pane shows at the field before a submit; the adapter reads them again
// here, so a body reaches the API only when it can be accepted.
import type { ContainerType, ServiceFrequency, WasteFraction } from "@waste/contracts/catalogue"
import type { VehicleType } from "@waste/contracts/vehicle-types"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import {
  keyMovedRefusal,
  MASTER_DATA_KIND_DETAILS,
  MASTER_DATA_MODULE,
  masterDataFieldErrors,
  masterDataFieldsOf,
  masterDataKindOf,
  masterDataTypedValues,
  presentMasterData,
  type MasterDataKind,
  type MasterDataLookups,
} from "@/lib/data/master-data"

import { create, get, listAll, patch, put } from "../client"
import { inheritedPresentation, patchOf, stampFacts, typed, webIdOf, type Client, type LocalRefusal, type MappingContext, type ResourceAdapter, type Resource, type ServerModule } from "./adapter"

export { ONE_CADENCE } from "@/lib/data/master-data"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

const CONTAINER_TYPE_PREFIX = MASTER_DATA_KIND_DETAILS["container-type"].prefix

/** The first rule the record breaks, as a refusal naming the field; undefined when the body can be accepted. */
function firstRefusal(kind: MasterDataKind, record: BusinessRecord): LocalRefusal | undefined {
  const [first] = Object.entries(masterDataFieldErrors(kind, record.submittedValues))
  return first === undefined ? undefined : refusal(first[0], first[1])
}

/** The kind's word for itself in a sentence. */
const lower = (kind: MasterDataKind) => MASTER_DATA_KIND_DETAILS[kind].label.toLowerCase()

/** The names the record's facts show, over what the store has loaded. */
function lookupsOver(context: MappingContext): MasterDataLookups {
  return {
    projectName: (projectWebId) => context.resolve.byServerId(context.resolve.serverIdOf(projectWebId) ?? "")?.name,
    containerTypeName: (webId) => {
      const serverId = context.resolve.serverIdOf(webId) ?? webId.slice(`${CONTAINER_TYPE_PREFIX}-`.length)
      return context.resolve.byServerId(serverId)?.name
    },
  }
}

/** The record a resource of a kind is: identity and stamps here, the presentation the values give (lib/data/master-data.ts). */
function recordOf(kind: MasterDataKind, resource: Resource, values: BusinessFormValues, context: MappingContext): BusinessRecord {
  const details = MASTER_DATA_KIND_DETAILS[kind]
  const fields = masterDataFieldsOf(kind, values)
  const shown = presentMasterData(fields, lookupsOver(context))
  return {
    id: webIdOf(details.prefix, resource.id),
    name: fields.name,
    context: shown.context,
    // No status on the wire: a row the API holds is in force, in the module's own word.
    status: "Effective",
    ...inheritedPresentation(undefined),
    ...stampFacts(resource, context.now),
    value: shown.value,
    description: `${details.label} of the company's master data.`,
    facts: shown.facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: shown.projectIds,
    recordKind: shown.recordKind,
    submittedValues: masterDataTypedValues(kind, values),
  }
}

/** A wire number as the form spells it: blank for null. */
const spelled = (value: number | null) => (value === null ? "" : String(value))

/** The typed fields the pane's record carries, read for the kind the adapter is. */
const fieldsOf = (kind: MasterDataKind, record: BusinessRecord) => masterDataFieldsOf(kind, record.submittedValues)

/** Whether the row was moved to another kind: refused, since a row keeps its kind. */
const rekinded = (kind: MasterDataKind, after: BusinessRecord) => {
  const typedKind = typed(after, "kind")
  return typedKind !== undefined && typedKind !== kind
}

// ---------------------------------------------------------------------------
// Waste fractions
// ---------------------------------------------------------------------------

export const wasteFractionAdapter: ResourceAdapter<WasteFraction> = {
  prefix: MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix,
  owns: (record) => masterDataKindOf(record) === "waste-fraction",
  statuses: undefined,
  list: (client) => listAll<WasteFraction>(client, "/waste-fractions"),
  toRecord: (fraction, context) => recordOf("waste-fraction", fraction, { name: fraction.name, key: fraction.key }, context),
  toCreateBody: (record) => {
    const refused = firstRefusal("waste-fraction", record)
    if (refused) return refused
    const fields = fieldsOf("waste-fraction", record)
    return { key: fields.key, name: fields.name }
  },
  toPatchBody: (before, after) => {
    if (rekinded("waste-fraction", after)) return refusal("kind", "A row keeps its kind")
    if (fieldsOf("waste-fraction", before).key !== fieldsOf("waste-fraction", after).key) return refusal("key", keyMovedRefusal("waste-fraction"))
    const refused = firstRefusal("waste-fraction", after)
    if (refused) return refused
    return patchOf(before, after, (record) => ({ name: fieldsOf("waste-fraction", record).name || record.name }))
  },
  create: (client, body) => create<WasteFraction>(client, "/waste-fractions", body).then((created) => created.body),
  update: (client, serverId, body) => patch<WasteFraction>(client, `/waste-fractions/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// Container types
// ---------------------------------------------------------------------------

export const containerTypeAdapter: ResourceAdapter<ContainerType> = {
  prefix: CONTAINER_TYPE_PREFIX,
  owns: (record) => masterDataKindOf(record) === "container-type",
  statuses: undefined,
  list: (client) => listAll<ContainerType>(client, "/container-types"),
  toRecord: (type, context) => recordOf("container-type", type, { name: type.name, volumeLitres: spelled(type.volumeLitres) }, context),
  toCreateBody: (record) => {
    const refused = firstRefusal("container-type", record)
    if (refused) return refused
    const fields = fieldsOf("container-type", record)
    return { name: fields.name, ...(fields.volumeLitres == null ? {} : { volumeLitres: fields.volumeLitres }) }
  },
  toPatchBody: (before, after) => {
    if (rekinded("container-type", after)) return refusal("kind", "A row keeps its kind")
    const refused = firstRefusal("container-type", after)
    if (refused) return refused
    return patchOf(before, after, (record) => {
      const read = fieldsOf("container-type", record)
      return { name: read.name || record.name, volumeLitres: read.volumeLitres ?? null }
    })
  },
  create: (client, body) => create<ContainerType>(client, "/container-types", body).then((created) => created.body),
  update: (client, serverId, body) => patch<ContainerType>(client, `/container-types/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// Service frequencies
// ---------------------------------------------------------------------------

export const serviceFrequencyAdapter: ResourceAdapter<ServiceFrequency> = {
  prefix: MASTER_DATA_KIND_DETAILS["service-frequency"].prefix,
  owns: (record) => masterDataKindOf(record) === "service-frequency",
  statuses: undefined,
  list: (client) => listAll<ServiceFrequency>(client, "/service-frequencies"),
  toRecord: (frequency, context) => {
    const project = context.resolve.byServerId(frequency.projectId)
    return recordOf(
      "service-frequency",
      frequency,
      {
        name: frequency.name,
        projectId: project?.id ?? webIdOf("project", frequency.projectId),
        description: frequency.description ?? "",
        collectionsPerWeek: spelled(frequency.collectionsPerWeek),
        weeksBetween: spelled(frequency.weeksBetween),
        daysBetween: spelled(frequency.daysBetween),
      },
      context,
    )
  },
  toCreateBody: (record, context) => {
    const fields = fieldsOf("service-frequency", record)
    const projectWebId = fields.projectId || record.projectIds?.[0]
    const projectId = projectWebId ? context.resolve.serverIdOf(projectWebId) : undefined
    if (projectId === undefined) return refusal("projectId", "Pick a project")
    const refused = firstRefusal("service-frequency", record)
    if (refused) return refused
    return {
      projectId,
      name: fields.name,
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.collectionsPerWeek == null ? {} : { collectionsPerWeek: fields.collectionsPerWeek }),
      ...(fields.weeksBetween == null ? {} : { weeksBetween: fields.weeksBetween }),
      ...(fields.daysBetween == null ? {} : { daysBetween: fields.daysBetween }),
    }
  },
  toPatchBody: (before, after) => {
    if (rekinded("service-frequency", after)) return refusal("kind", "A row keeps its kind")
    const was = fieldsOf("service-frequency", before)
    const is = fieldsOf("service-frequency", after)
    if ((is.projectId || after.projectIds?.[0]) !== (was.projectId || before.projectIds?.[0])) return refusal("projectId", `A ${lower("service-frequency")} stays in its project`)
    const refused = firstRefusal("service-frequency", after)
    if (refused) return refused
    return patchOf(before, after, (record) => {
      const read = fieldsOf("service-frequency", record)
      return {
        name: read.name || record.name,
        description: read.description ?? null,
        collectionsPerWeek: read.collectionsPerWeek ?? null,
        weeksBetween: read.weeksBetween ?? null,
        daysBetween: read.daysBetween ?? null,
      }
    })
  },
  create: (client, body) => create<ServiceFrequency>(client, "/service-frequencies", body).then((created) => created.body),
  update: (client, serverId, body) => patch<ServiceFrequency>(client, `/service-frequencies/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// Vehicle types
// ---------------------------------------------------------------------------

/** What a vehicle type's update carries: a patch of the type, the whole set of container types, or both, each to its own route. */
type VehicleTypeWrite = {
  type?: { name?: string; description?: string | null }
  containerTypeIds?: string[]
}

/** The server ids the form's container types stand for, or a refusal for one the store does not hold. */
function containerTypeServerIds(webIds: readonly string[], context: MappingContext): string[] | LocalRefusal {
  const ids: string[] = []
  for (const webId of webIds) {
    const serverId = context.resolve.serverIdOf(webId)
    if (serverId === undefined) return refusal("containerTypeIds", "Pick container types the API holds")
    ids.push(serverId)
  }
  return ids
}

/** Whether two sets of container types differ as sets: the form's order is the order they were ticked in, not a change. */
const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",")

export const vehicleTypeAdapter: ResourceAdapter<VehicleType> = {
  prefix: MASTER_DATA_KIND_DETAILS["vehicle-type"].prefix,
  owns: (record) => masterDataKindOf(record) === "vehicle-type",
  statuses: undefined,
  list: (client) => listAll<VehicleType>(client, "/vehicle-types"),
  toRecord: (type, context) =>
    recordOf(
      "vehicle-type",
      type,
      {
        name: type.name,
        key: type.key,
        description: type.description ?? "",
        // By the web id the store knows each container type under: a row made this session keeps its minted one.
        containerTypeIds: type.containerTypeIds.map((id) => context.resolve.byServerId(id)?.id ?? webIdOf(CONTAINER_TYPE_PREFIX, id)).join(","),
      },
      context,
    ),
  toCreateBody: (record, context) => {
    const refused = firstRefusal("vehicle-type", record)
    if (refused) return refused
    const fields = fieldsOf("vehicle-type", record)
    const containerTypeIds = containerTypeServerIds(fields.containerTypeIds ?? [], context)
    if ("path" in containerTypeIds) return containerTypeIds
    return { key: fields.key, name: fields.name, ...(fields.description ? { description: fields.description } : {}), containerTypeIds }
  },
  toPatchBody: (before, after, context) => {
    if (rekinded("vehicle-type", after)) return refusal("kind", "A row keeps its kind")
    const was = fieldsOf("vehicle-type", before)
    const is = fieldsOf("vehicle-type", after)
    if (was.key !== is.key) return refusal("key", keyMovedRefusal("vehicle-type"))
    const refused = firstRefusal("vehicle-type", after)
    if (refused) return refused
    const type = patchOf(before, after, (record) => {
      const read = fieldsOf("vehicle-type", record)
      return { name: read.name || record.name, description: read.description ?? null }
    })
    let containerTypeIds: string[] | undefined
    if (!sameSet(was.containerTypeIds ?? [], is.containerTypeIds ?? [])) {
      const ids = containerTypeServerIds(is.containerTypeIds ?? [], context)
      if ("path" in ids) return ids
      containerTypeIds = ids
    }
    if (type === null && containerTypeIds === undefined) return null
    const write: VehicleTypeWrite = { ...(type === null ? {} : { type }), ...(containerTypeIds === undefined ? {} : { containerTypeIds }) }
    return write
  },
  create: (client, body) => create<VehicleType>(client, "/vehicle-types", body).then((created) => created.body),
  // The type first, then the whole set through its own route; the answer is
  // the type as it now stands. Two requests are still two: a type patched
  // before a set the transport loses stays patched, and the pane's refusal
  // says the write did not land while the list shows the old name until a
  // reload — the trade-off the planning adapters accept as well.
  update: async (client, serverId, body) => {
    const write = body as VehicleTypeWrite
    let type: VehicleType | undefined
    if (write.type !== undefined) type = await patch<VehicleType>(client, `/vehicle-types/${serverId}`, write.type)
    if (write.containerTypeIds !== undefined) type = await put<VehicleType>(client, `/vehicle-types/${serverId}/container-types`, { containerTypeIds: write.containerTypeIds })
    return type ?? (await get<VehicleType>(client, `/vehicle-types/${serverId}`))
  },
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/** Settings → Operations → Master data, and the module the fixture pickers point at: the container types before the vehicle types that name them. */
export const masterDataModule: ServerModule = {
  workspaceId: MASTER_DATA_MODULE.workspaceId,
  moduleId: MASTER_DATA_MODULE.moduleId,
  resources: [wasteFractionAdapter, containerTypeAdapter, serviceFrequencyAdapter, vehicleTypeAdapter],
}

export type { Client }
