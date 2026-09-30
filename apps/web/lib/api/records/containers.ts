// Containers on the prototype's records (Issue #181, slice 5b of #81): the
// Registry's Container as the rows of `resources.containers`, each with the
// Container Service Placement it serves at filed under it. The wire shapes are
// the contracts' (`@waste/contracts/containers`, `stock`), imported as types
// so no zod reaches the bundle; the routes are apps/api/src/routes/
// containers.ts and lifecycle.ts.
//
// A container is two resources on the wire — the identity a person reads off
// the bin, and the effective-dated placements of where it serves — and one
// record here: the read lists both and files every placement under its
// container, and the record shows one: the placement the ledger has the
// container in service at, else its latest by start (a placement the seed
// wrote before any movement, or one that has ended). The status is the
// Container Asset State, the ledger's reading (ADR-0003) — In warehouse, In
// service, In maintenance, Retired, or No stock record for a container with
// no movement yet — which moves only by the lifecycle's commands, so the
// adapter lists no `statuses` and the store refuses every move an edit makes.
//
// An edit corrects the identity through `PATCH /containers/:id` and, where
// the container has a placement, that placement's fraction, its cadence
// override and an end the ledger has already set, through
// `PATCH /placements/:id`: two requests, the container's first, then the row
// read back with its placements (the residual the planning adapters accept:
// two requests are not one transaction). A placement's end is the ledger's:
// an open one ends only when its container is returned or decommissioned, and
// an end is corrected, never taken back — both refused here in those words.
// A period's end is spelled as everywhere in the web: the form's last day in,
// the wire's first day out (ADR-0005), a day added on the way out.
//
// Relations by web id through the store's resolver: the project and the
// container type (master data, slice 2) by name; the warehouse (slice 5a) and
// the subscription (slice 9a) as id chips until their modules load, and the
// property or point a subscription is at is 9b's. No fixture lends its id: a
// server container is `asset-<uuid>` from the start, the API's id the handle
// the schemes' groups name it by (the plan on #81, fixture ids (b)).
import type { Container, ContainerOwnership, ContainerServicePlacement } from "@waste/contracts/containers"
import type { StockMovement } from "@waste/contracts/stock"
import { CONTAINER_OWNERSHIPS } from "@waste/domain/registry/vocabulary"
import { ADJUSTMENT_TARGETS, STOCK_PLACES } from "@waste/domain/resources/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { OWNERSHIP_LABELS } from "@/lib/data/containers"
import { MASTER_DATA_KIND_DETAILS } from "@/lib/data/master-data-kinds"

import { command, create, get, listAll, patch } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, patchOf, stampFacts, statusLabel, typed, webIdOf, type Client, type CommandInput, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { instantOn, projectTimezoneOf, shownOn } from "./clock"
import { nameVia, referencedServerId, typedReference, webIdVia } from "./references"

/** The workspace module the containers are the rows of. */
export const CONTAINERS_MODULE: ModuleLocation = { workspaceId: "resources", moduleId: "containers" }

/** A container as the adapter reads it: the resource, and every placement it has had. */
export type ContainerResource = Container & { placements: ContainerServicePlacement[] }

/** What a container with no movement yet reads as: it has no asset state. */
export const NO_STOCK_RECORD = "No stock record"

const CONTAINER_PREFIX = "asset"
const MOVEMENT_PREFIX = "movement"
const CONTAINER_TYPE_PREFIX = MASTER_DATA_KIND_DETAILS["container-type"].prefix
const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The form's last day in from the wire's first day out (half-open), and back. */
const lastDayIn = (firstDayOut: string) => addDays(firstDayOut, -1)
const firstDayOut = (lastDayIn: string) => addDays(lastDayIn, 1)

const isOwnership = (value: string): value is ContainerOwnership => (CONTAINER_OWNERSHIPS as readonly string[]).includes(value)

/** The placement a record shows: the one the ledger has the container in service at, else the latest by start. */
function placementShown(resource: ContainerResource): ContainerServicePlacement | undefined {
  const serving = resource.assetState?.placementId
  if (serving) {
    const found = resource.placements.find((placement) => placement.id === serving)
    if (found) return found
  }
  return [...resource.placements].sort((a, b) => b.validFrom.localeCompare(a.validFrom) || b.id.localeCompare(a.id))[0]
}

/** A placement's period as a person reads it: its first day, and its last or "open". */
const periodOf = (placement: ContainerServicePlacement) => (placement.validTo === null ? `From ${placement.validFrom}, open` : `From ${placement.validFrom} to ${lastDayIn(placement.validTo)}`)

const PICK_CONTAINER_TYPE = "Pick a container type the API holds"
const PICK_FRACTION = "Pick a waste fraction the API holds"
const PICK_FREQUENCY = "Pick a service frequency the API holds"
const OWNERSHIP_WORDS = `Ownership is ${CONTAINER_OWNERSHIPS.slice(0, -1).join(", ")} or ${CONTAINER_OWNERSHIPS.at(-1)}`
export const PLACEMENT_ENDS_BY_THE_LEDGER = "A placement ends when its container is returned or decommissioned"
const PLACEMENT_END_KEPT = "A placement's end is corrected, never taken back"

/** The identity fields of a container as the form spells them, read for a patch. */
function identityOf(record: BusinessRecord, context: MappingContext) {
  const ownership = typed(record, "ownership")
  return {
    label: typed(record, "containerId") ?? record.name,
    containerTypeId: referencedServerId(typed(record, "containerType") ?? "", CONTAINER_TYPE_PREFIX, context),
    barcode: typed(record, "barcode") ?? null,
    rfid: typed(record, "rfid") ?? null,
    serialNumber: typed(record, "serialNumber") ?? null,
    ownership: ownership !== undefined && isOwnership(ownership) ? ownership : undefined,
    notes: typed(record, "description") ?? null,
  }
}

/** What a container's update carries: a patch of the container, a patch of its placement, or both, each to its own route. */
type ContainerWrite = {
  container?: Record<string, unknown>
  placement?: { id: string; patch: Record<string, unknown> }
}

/** The placement half of an edit: the fraction, the cadence override and a corrected end; null when none moved. */
function placementPatchOf(before: BusinessRecord, after: BusinessRecord, context: MappingContext): { id: string; patch: Record<string, unknown> } | null | LocalRefusal {
  const moved = (key: string) => typed(before, key) !== typed(after, key)
  if (!moved("wasteFraction") && !moved("serviceFrequencyId") && !moved("placementTo")) return null
  const placementId = typed(before, "placementId")
  if (placementId === undefined) return refusal("wasteFraction", `${before.name} serves nowhere yet: issue it into service first`)
  const body: Record<string, unknown> = {}
  if (moved("wasteFraction")) {
    const id = typedReference(after, "wasteFraction", "fraction", context, PICK_FRACTION)
    if (id === undefined) return refusal("wasteFraction", PICK_FRACTION)
    if (isLocalRefusal(id)) return id
    body.wasteFractionId = id
  }
  if (moved("serviceFrequencyId")) {
    const id = typedReference(after, "serviceFrequencyId", "frequency", context, PICK_FREQUENCY)
    if (isLocalRefusal(id)) return id
    body.serviceFrequencyId = id ?? null
  }
  if (moved("placementTo")) {
    if (typed(before, "placementTo") === undefined) return refusal("placementTo", PLACEMENT_ENDS_BY_THE_LEDGER)
    const lastDay = typed(after, "placementTo")
    if (lastDay === undefined) return refusal("placementTo", PLACEMENT_END_KEPT)
    body.validTo = firstDayOut(lastDay)
  }
  return { id: placementId, patch: body }
}

// ---------------------------------------------------------------------------
// The lifecycle's commands
// ---------------------------------------------------------------------------
//
// The ledger's five commands (`receive`, `return`, `transfer`,
// `decommission`, `adjust`: `POST /containers/:id/<command>`) and the one door
// into service, `issue`, which is the Registry's `POST
// /containers/:id/placements`. Each dialog's input becomes the contract's
// body here — a warehouse, a fraction, a frequency by web id through the
// resolver, or by the id chip a row of a module not yet switched shows; a
// subscription by its id until 9a switches the subscriptions; the form's last
// day in service as the wire's first day out — or a refusal naming the field.
// What the container's state allows is the API's to say: every command is
// offered and its 409 speaks (the rules on #81). A command answers the
// movement (or the placement) it wrote, so the row is read back after it,
// with its placements, and replaces the one the store holds.

/** The sentence the contract refuses a warehouse named with scrap, or none named with a place in stock, in (`WAREHOUSE_WITH_A_STOCK_PLACE`, @waste/contracts/stock), quoted since the web imports no zod at runtime; the test holds the two equal. */
export const WAREHOUSE_WITH_A_STOCK_PLACE = "Name the warehouse with warehouse or maintenance and not with scrap"

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** A dialog value as a non-blank string, or undefined. */
function said(input: CommandInput, key: string): string | undefined {
  const value = input[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** The server id a dialog names a row by (references.ts), undefined when it names none the API holds. */
function referenced(input: CommandInput, key: string, prefix: string, context: MappingContext, bare = false): string | undefined {
  const value = said(input, key)
  return value === undefined ? undefined : referencedServerId(value, prefix, context, bare)
}

/** When it happened, on the person's word and the container's project's clock, as an instant; absent is the request's clock. */
function occurredOf(input: CommandInput, record: BusinessRecord, context: MappingContext): { occurredAt?: string } | LocalRefusal {
  const value = said(input, "occurredAt")
  if (value === undefined) return {}
  const occurredAt = instantOn(value, projectTimezoneOf(record, context))
  return occurredAt === undefined ? refusal("occurredAt", "Give when it happened as a date and a time") : { occurredAt }
}

/** The optional words a movement carries: the paper it quotes and why. */
const wordsOf = (input: CommandInput, keys: readonly ("reason" | "reference")[]) => Object.fromEntries(keys.flatMap((key) => (said(input, key) === undefined ? [] : [[key, said(input, key)]])))

const PICK_WAREHOUSE = "Pick a warehouse the API holds"
const IN_STOCK = "It arrives in a warehouse or in maintenance at one"

/** The warehouse a command arrives at, required. */
function warehouseOf(input: CommandInput, context: MappingContext): string | LocalRefusal {
  return referenced(input, "warehouseId", "warehouse", context) ?? refusal("warehouseId", PICK_WAREHOUSE)
}

/** A place in stock the dialog names; the contract's default (a warehouse) when it names none. */
function stockPlaceOf(input: CommandInput): { toKind?: string } | LocalRefusal {
  const toKind = said(input, "toKind")
  if (toKind === undefined) return {}
  return (STOCK_PLACES as readonly string[]).includes(toKind) ? { toKind } : refusal("toKind", IN_STOCK)
}

/** The wire's first day out from the dialog's last day in service; a refusal when it is no day. */
function endOf(input: CommandInput): string | undefined | LocalRefusal {
  const lastDay = said(input, "lastDay")
  if (lastDay === undefined) return undefined
  return ISO_DAY.test(lastDay) ? firstDayOut(lastDay) : refusal("lastDay", "Give the last day it serves")
}

/** Composes a body from its parts, the first refusal among them winning. */
function bodyOf(...parts: Array<Record<string, unknown> | LocalRefusal>): Record<string, unknown> | LocalRefusal {
  const refused = parts.find(isLocalRefusal)
  if (refused !== undefined) return refused
  return Object.assign({}, ...parts) as Record<string, unknown>
}

/** The container as it now stands, with its placements: what every command answers, since the API answers the movement it wrote. */
async function readBack(client: Client, serverId: string): Promise<ContainerResource> {
  const [container, placements] = await Promise.all([get<Container>(client, `/containers/${serverId}`), listAll<ContainerServicePlacement>(client, "/placements", { containerId: serverId })])
  return { ...container, placements }
}

/** A command posted to its path on the container, then the row read back. */
const lifecycle = (path: string, verb: string, toBody: NonNullable<RecordCommand<ContainerResource>["toBody"]>): RecordCommand<ContainerResource> => ({
  toBody,
  run: async (client, serverId, body) => {
    await command<StockMovement | ContainerServicePlacement>(client, `/containers/${serverId}/${path}`, body)
    return readBack(client, serverId)
  },
  refused: (record) => `${record.name} was not ${verb}`,
})

/** A reason a command must carry. */
const reasonOf = (input: CommandInput): { reason: string } | LocalRefusal => {
  const reason = said(input, "reason")
  return reason === undefined ? refusal("reason", "Say why") : { reason }
}

export const CONTAINER_COMMANDS = {
  receive: lifecycle("receive", "received", (input, record, context) => {
    const warehouseId = warehouseOf(input, context)
    return bodyOf(isLocalRefusal(warehouseId) ? warehouseId : { warehouseId }, occurredOf(input, record, context), wordsOf(input, ["reference"]))
  }),
  return: lifecycle("return", "returned", (input, record, context) => {
    const warehouseId = warehouseOf(input, context)
    const validTo = endOf(input) ?? refusal("lastDay", "Give the last day it serves")
    return bodyOf(isLocalRefusal(warehouseId) ? warehouseId : { warehouseId }, stockPlaceOf(input), isLocalRefusal(validTo) ? validTo : { validTo }, occurredOf(input, record, context), wordsOf(input, ["reason", "reference"]))
  }),
  transfer: lifecycle("transfer", "transferred", (input, record, context) => {
    const warehouseId = warehouseOf(input, context)
    return bodyOf(isLocalRefusal(warehouseId) ? warehouseId : { warehouseId }, stockPlaceOf(input), occurredOf(input, record, context), wordsOf(input, ["reason", "reference"]))
  }),
  decommission: lifecycle("decommission", "decommissioned", (input, record, context) => {
    // In service the API requires the last day, out of service it refuses one: the route knows which.
    const validTo = endOf(input)
    return bodyOf(reasonOf(input), validTo === undefined ? {} : isLocalRefusal(validTo) ? validTo : { validTo }, occurredOf(input, record, context), wordsOf(input, ["reference"]))
  }),
  adjust: lifecycle("adjust", "adjusted", (input, record, context) => {
    const toKind = said(input, "toKind")
    if (toKind === undefined || !(ADJUSTMENT_TARGETS as readonly string[]).includes(toKind)) return refusal("toKind", "Say where the ledger should have it: a warehouse, maintenance at one, or scrap")
    const named = said(input, "warehouseId") !== undefined
    if ((toKind === "scrap") === named) return refusal("warehouseId", WAREHOUSE_WITH_A_STOCK_PLACE)
    const warehouseId = toKind === "scrap" ? null : warehouseOf(input, context)
    const corrects = said(input, "correctsMovementId")
    const correctedId = corrects === undefined ? undefined : referencedServerId(corrects, MOVEMENT_PREFIX, context, true)
    const correctsMovementId = corrects === undefined ? {} : correctedId !== undefined ? { correctsMovementId: correctedId } : refusal("correctsMovementId", "Give the id of the movement it corrects")
    return bodyOf({ toKind }, isLocalRefusal(warehouseId) ? warehouseId : { warehouseId }, reasonOf(input), correctsMovementId, occurredOf(input, record, context))
  }),
  // The Registry's one door into service: the placement and the issue movement together.
  issue: lifecycle("placements", "issued into service", (input, record, context) => {
    const subscriptionId = referenced(input, "subscriptionId", "subscription", context, true)
    if (subscriptionId === undefined) return refusal("subscriptionId", "Give the subscription's id")
    const wasteFractionId = referenced(input, "wasteFractionId", "fraction", context)
    if (wasteFractionId === undefined) return refusal("wasteFractionId", PICK_FRACTION)
    const frequencyNamed = said(input, "serviceFrequencyId") !== undefined
    const serviceFrequencyId = referenced(input, "serviceFrequencyId", "frequency", context)
    if (frequencyNamed && serviceFrequencyId === undefined) return refusal("serviceFrequencyId", PICK_FREQUENCY)
    const validFrom = said(input, "validFrom")
    if (validFrom === undefined || !ISO_DAY.test(validFrom)) return refusal("validFrom", "Give the first day it serves")
    return bodyOf({ subscriptionId, wasteFractionId }, serviceFrequencyId === undefined ? {} : { serviceFrequencyId }, { validFrom }, occurredOf(input, record, context), wordsOf(input, ["reference"]))
  }),
} satisfies Record<string, RecordCommand<ContainerResource>>

/** The names of the container's commands, as the dialogs send them. */
export type ContainerCommand = keyof typeof CONTAINER_COMMANDS

/** One container's ledger, oldest first: its details' history. */
export function containerMovements(client: Client, serverId: string): Promise<StockMovement[]> {
  return listAll<StockMovement>(client, `/containers/${serverId}/movements`)
}

export const containerAdapter: ResourceAdapter<ContainerResource> = {
  prefix: CONTAINER_PREFIX,
  owns: ofKind(CONTAINER_PREFIX, ["Container"]),
  // The asset state is the ledger's, moved only by the lifecycle's commands.
  statuses: undefined,
  list: async (client) => {
    const [containers, placements] = await Promise.all([listAll<Container>(client, "/containers"), listAll<ContainerServicePlacement>(client, "/placements")])
    const byContainer = new Map<string, ContainerServicePlacement[]>()
    for (const placement of placements) {
      const filed = byContainer.get(placement.containerId)
      if (filed === undefined) byContainer.set(placement.containerId, [placement])
      else filed.push(placement)
    }
    return containers.map((container) => ({ ...container, placements: byContainer.get(container.id) ?? [] }))
  },
  toRecord: (resource, context) => {
    const project = context.resolve.byServerId(resource.projectId)
    const projectWebId = project?.id ?? webIdOf("project", resource.projectId)
    const typeName = nameVia(context, "container-type", resource.containerTypeId)
    const state = resource.assetState
    const status = state === null ? NO_STOCK_RECORD : statusLabel(state.status)
    const placement = placementShown(resource)
    const facts: Record<string, string> = {
      "Container ID": resource.label,
      Barcode: resource.barcode ?? "Not recorded",
      RFID: resource.rfid ?? "Not recorded",
      "Serial number": resource.serialNumber ?? "Not recorded",
      "Container type": typeName,
      Ownership: OWNERSHIP_LABELS[resource.ownership],
      Project: project?.name ?? projectWebId,
      "Asset state": status,
    }
    if (state !== null) {
      if (state.warehouseId !== null) facts.Warehouse = nameVia(context, "warehouse", state.warehouseId)
      facts["State since"] = shownOn(state.since, project === undefined ? undefined : typed(project, "timezone"))
    }
    if (placement !== undefined) {
      facts["Waste fractions"] = nameVia(context, "fraction", placement.wasteFractionId)
      facts.Placement = periodOf(placement)
      facts.Subscription = nameVia(context, "subscription", placement.subscriptionId)
      if (placement.effectiveServiceFrequencyId !== null) facts["Service frequency"] = nameVia(context, "frequency", placement.effectiveServiceFrequencyId)
    }
    if (resource.notes !== null) facts.Notes = resource.notes
    return {
      id: webIdOf(CONTAINER_PREFIX, resource.id),
      name: resource.label,
      context: [typeName, project?.name].filter(Boolean).join(" · "),
      status,
      ...inheritedPresentation(undefined),
      ...stampFacts(resource, context.now),
      description: "A container of the registry; where it stands is its Stock Movement ledger's reading.",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      recordKind: "Container",
      submittedValues: {
        projectId: projectWebId,
        containerId: resource.label,
        barcode: resource.barcode ?? "",
        rfid: resource.rfid ?? "",
        serialNumber: resource.serialNumber ?? "",
        containerType: webIdVia(context, "container-type", resource.containerTypeId),
        ownership: resource.ownership,
        description: resource.notes ?? "",
        assetStatus: state?.status ?? "",
        warehouseId: state?.warehouseId ? webIdVia(context, "warehouse", state.warehouseId) : "",
        placementId: placement?.id ?? "",
        subscriptionId: placement ? webIdVia(context, "subscription", placement.subscriptionId) : "",
        wasteFraction: placement ? webIdVia(context, "fraction", placement.wasteFractionId) : "",
        serviceFrequencyId: placement?.serviceFrequencyId ? webIdVia(context, "frequency", placement.serviceFrequencyId) : "",
        placementFrom: placement?.validFrom ?? "",
        placementTo: placement?.validTo ? lastDayIn(placement.validTo) : "",
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectWebId = typed(record, "projectId") ?? record.projectIds?.[0]
    const projectId = projectWebId ? context.resolve.serverIdOf(projectWebId) : undefined
    if (projectId === undefined) return refusal("projectId", "Pick a project")
    const label = typed(record, "containerId")
    if (label === undefined) return refusal("containerId", "A container needs its Container ID")
    const containerTypeId = typedReference(record, "containerType", CONTAINER_TYPE_PREFIX, context, PICK_CONTAINER_TYPE)
    if (containerTypeId === undefined) return refusal("containerType", PICK_CONTAINER_TYPE)
    if (isLocalRefusal(containerTypeId)) return containerTypeId
    const ownership = typed(record, "ownership")
    if (ownership !== undefined && !isOwnership(ownership)) return refusal("ownership", OWNERSHIP_WORDS)
    const optional = (key: string, member: string) => {
      const value = typed(record, key)
      return value === undefined ? {} : { [member]: value }
    }
    return {
      projectId,
      label,
      containerTypeId,
      ...optional("barcode", "barcode"),
      ...optional("rfid", "rfid"),
      ...optional("serialNumber", "serialNumber"),
      ...(ownership === undefined ? {} : { ownership }),
      ...optional("description", "notes"),
    }
  },
  toPatchBody: (before, after, context) => {
    if ((typed(after, "projectId") ?? after.projectIds?.[0]) !== (typed(before, "projectId") ?? before.projectIds?.[0])) return refusal("projectId", "A container stays in its project")
    if (typed(after, "containerId") === undefined && after.name.trim() === "") return refusal("containerId", "A container needs its Container ID")
    if (typed(before, "containerType") !== typed(after, "containerType")) {
      const id = typedReference(after, "containerType", CONTAINER_TYPE_PREFIX, context, PICK_CONTAINER_TYPE)
      if (id === undefined) return refusal("containerType", PICK_CONTAINER_TYPE)
      if (isLocalRefusal(id)) return id
    }
    const ownership = typed(after, "ownership")
    if (ownership !== undefined && !isOwnership(ownership)) return refusal("ownership", OWNERSHIP_WORDS)
    const container = patchOf(before, after, (record) => identityOf(record, context))
    const placement = placementPatchOf(before, after, context)
    if (isLocalRefusal(placement)) return placement
    if (container === null && placement === null) return null
    const write: ContainerWrite = { ...(container === null ? {} : { container }), ...(placement === null ? {} : { placement }) }
    return write
  },
  create: async (client, body) => {
    const created = await create<Container>(client, "/containers", body)
    // A container just registered serves nowhere: it has no placement to read.
    return { ...created.body, placements: [] }
  },
  // The container first, then its placement, then the row read back with its
  // placements, so what the write answers is what the next load reads.
  update: async (client, serverId, body) => {
    const write = body as ContainerWrite
    let container: Container | undefined
    if (write.container !== undefined) container = await patch<Container>(client, `/containers/${serverId}`, write.container)
    if (write.placement !== undefined) await patch<ContainerServicePlacement>(client, `/placements/${write.placement.id}`, write.placement.patch)
    container ??= await get<Container>(client, `/containers/${serverId}`)
    const placements = await listAll<ContainerServicePlacement>(client, "/placements", { containerId: serverId })
    return { ...container, placements }
  },
  commands: CONTAINER_COMMANDS,
}

/** Resources › Containers: the registry's containers, each with where it serves. */
export const containersModule: ServerModule = {
  workspaceId: CONTAINERS_MODULE.workspaceId,
  moduleId: CONTAINERS_MODULE.moduleId,
  resources: [containerAdapter],
}

// ---------------------------------------------------------------------------
// The inventory: the ledger across containers
// ---------------------------------------------------------------------------
//
// `resources.inventory` on the wire is what moved (`GET /stock-movements`,
// oldest first), not the prototype's stock items with their balances: what
// stands in a warehouse today is the containers' own reading, and a movement
// is recorded by a command on its container. So the module lists the ledger
// read-only — a row per movement, its container named by label from the
// containers loaded before it — and every write is refused: the ledger is
// append-only, and a wrong movement is corrected by adjusting its container.

/** The workspace module the ledger is the rows of. */
export const INVENTORY_MODULE: ModuleLocation = { workspaceId: "resources", moduleId: "inventory" }

const APPEND_ONLY = "The ledger is append-only: a wrong movement is corrected by adjusting its container"

/** Where a movement leaves from or arrives at, as a person reads it: a supplier, a warehouse, maintenance at one, service, scrap. */
function placeOf(kind: StockMovement["fromKind"], warehouseId: string | null, context: MappingContext): string {
  const warehouse = warehouseId === null ? undefined : nameVia(context, "warehouse", warehouseId)
  if (kind === "warehouse") return warehouse ?? "Warehouse"
  if (kind === "maintenance") return warehouse === undefined ? "Maintenance" : `Maintenance at ${warehouse}`
  return statusLabel(kind)
}

/** A ledger row as the store holds a resource: it is never updated, so both its stamps are the instant it was appended. */
export type LedgerRow = StockMovement & { createdAt: string; updatedAt: string }
export const ledgerRow = (movement: StockMovement): LedgerRow => ({ ...movement, createdAt: movement.recordedAt, updatedAt: movement.recordedAt })

export const stockMovementAdapter: ResourceAdapter<LedgerRow> = {
  prefix: MOVEMENT_PREFIX,
  owns: ofKind(MOVEMENT_PREFIX, ["Stock movement"]),
  statuses: undefined,
  list: async (client) => (await listAll<StockMovement>(client, "/stock-movements")).map(ledgerRow),
  toRecord: (movement, context) => {
    const project = context.resolve.byServerId(movement.projectId)
    const timezone = project === undefined ? undefined : typed(project, "timezone")
    const projectWebId = project?.id ?? webIdOf("project", movement.projectId)
    const container = nameVia(context, CONTAINER_PREFIX, movement.containerId)
    const kind = statusLabel(movement.kind)
    const from = placeOf(movement.fromKind, movement.fromWarehouseId, context)
    const to = placeOf(movement.toKind, movement.toWarehouseId, context)
    const facts: Record<string, string> = {
      Kind: kind,
      Container: container,
      From: from,
      To: to,
      "Occurred at": shownOn(movement.occurredAt, timezone),
      "Recorded at": shownOn(movement.recordedAt, timezone),
      Project: project?.name ?? projectWebId,
    }
    if (movement.reason !== null) facts.Reason = movement.reason
    if (movement.reference !== null) facts.Reference = movement.reference
    if (movement.placementId !== null) facts.Placement = movement.placementId
    if (movement.correctsMovementId !== null) facts.Corrects = webIdOf(MOVEMENT_PREFIX, movement.correctsMovementId)
    return {
      id: webIdOf(MOVEMENT_PREFIX, movement.id),
      name: `${kind} · ${container}`,
      context: `${from} → ${to}`,
      status: kind,
      ...inheritedPresentation(undefined),
      value: shownOn(movement.occurredAt, timezone).slice(0, 10),
      ...stampFacts(movement, context.now),
      description: "A Stock Movement of the container ledger, append-only.",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      recordKind: "Stock movement",
      submittedValues: { containerId: webIdVia(context, CONTAINER_PREFIX, movement.containerId), kind: movement.kind },
    }
  },
  toPatchBody: () => refusal("kind", APPEND_ONLY),
  update: () => Promise.reject(new Error(APPEND_ONLY)),
}

/** Resources › Inventory: the ledger, after the containers its rows name. */
export const inventoryModule: ServerModule = {
  workspaceId: INVENTORY_MODULE.workspaceId,
  moduleId: INVENTORY_MODULE.moduleId,
  resources: [stockMovementAdapter],
}

export type { Client }
