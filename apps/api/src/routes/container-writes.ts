// A Container's writes (Issue #78), the one spelling `POST /containers`,
// `PATCH /containers/:id` and the CSV import (#291 slice 12) all run: the
// project held to the caller's, the type this company's, the label one
// container's inside the company in the route's own sentence, and every
// answer read through the one statement that carries the ledger's reading.
// Each takes the request's transaction, or a savepoint of it, and the caller;
// the grant is the caller's to have checked. `containerByLabel` is the key a
// person knows a container by in a file, the label read off the bin.
import type { AssetState } from "@waste/contracts/stock"
import type { Container, ContainerCreate, ContainerOwnership, ContainerPatch } from "@waste/contracts/containers"
import type { Tx } from "@waste/db/client"
import { assetStateOf, assetStatus } from "@waste/db/query/asset-state"
import { container } from "@waste/db/schema/containers"
import type { AssetStatus } from "@waste/domain/resources/vocabulary"
import { and, eq, sql } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { newId } from "../ids"
import { containerScope, noSuchContainer } from "./lifecycle"
import { requireContainerType } from "./references"
import { refuseDuplicate, stampsOf } from "./shared"

export const containerColumns = {
  id: container.id,
  projectId: container.projectId,
  label: container.label,
  containerTypeId: container.containerTypeId,
  barcode: container.barcode,
  rfid: container.rfid,
  serialNumber: container.serialNumber,
  ownership: container.ownership,
  notes: container.notes,
  createdAt: container.createdAt,
  updatedAt: container.updatedAt,
}

/** The ledger's reading beside the container's own columns: its latest movement, nulls for a container with none. */
const stateColumns = (state: ReturnType<typeof assetStateOf>) => ({
  stateStatus: assetStatus(state.toKind),
  stateWarehouseId: state.toWarehouseId,
  statePlacementId: state.placementId,
  stateSince: state.occurredAt,
  stateMovementId: state.movementId,
})

/** The container's columns and the projection's, as the one statement below selects them; the projection's are null on a LATERAL left join that found no movement. */
export type ContainerRow = Pick<typeof container.$inferSelect, keyof typeof containerColumns> & {
  stateStatus: AssetStatus | null
  stateWarehouseId: string | null
  statePlacementId: string | null
  stateSince: Date | null
  stateMovementId: string | null
}

/**
 * The one statement every container is read through: the row with the
 * ledger's reading joined LATERAL — one probe per row for the container's
 * latest movement (`assetStateOf`) — so a page, a single read and the answer
 * to a write all say the same thing about where a container is. The
 * subquery is handed back beside the query for a filter over it.
 */
export function containersFrom(tx: Tx, companyId: string) {
  const state = assetStateOf(tx, companyId, container.id)
  return { state, query: tx.select({ ...containerColumns, ...stateColumns(state) }).from(container).leftJoinLateral(state, sql`true`) }
}

/** The reading as the wire spells it: null with no movement, else where the latest one left the container. */
function assetStateOfRow(row: ContainerRow): AssetState | null {
  if (row.stateMovementId === null) return null
  if (row.stateStatus === null || row.stateSince === null) {
    // A movement is NOT NULL on `occurred_at`, and the kind check keeps every arrival at a place with a state: a null beside a movement is a broken invariant, not a client's doing.
    throw new Error(`stock_movement ${row.stateMovementId} has no ${row.stateStatus === null ? "asset state" : "occurred_at"} to answer`)
  }
  return { status: row.stateStatus, warehouseId: row.stateWarehouseId, placementId: row.statePlacementId, since: row.stateSince.toISOString(), movementId: row.stateMovementId }
}

/** The reading a container has before any movement: what a create answers, since a row just made has none by construction. */
const NO_STATE = { stateStatus: null, stateWarehouseId: null, statePlacementId: null, stateSince: null, stateMovementId: null }

/** The row on the wire. `ownership` is text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
export function containerOf(row: ContainerRow): Container {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    containerTypeId: row.containerTypeId,
    barcode: row.barcode,
    rfid: row.rfid,
    serialNumber: row.serialNumber,
    ownership: row.ownership as ContainerOwnership,
    notes: row.notes,
    assetState: assetStateOfRow(row),
    ...stampsOf(row),
  }
}

/** `unique (company_id, label)`: a label is read off a bin anywhere in the company, so it is the company's and not a project's. */
export const LABEL_TAKEN = "container_label_key"
export const labelTaken = (label: string) => `This company already has a container labelled ${label}`

/** One container of this company by id, inside the caller's projects, with the ledger's reading; undefined when it is neither. */
export async function findContainer(tx: Tx, principal: Principal, id: string): Promise<ContainerRow | undefined> {
  const [row] = await containersFrom(tx, principal.companyId)
    .query.where(and(containerScope(principal), eq(container.id, id)))
    .limit(1)
  return row
}

/** The row a patch just changed, read back through the one statement, so the answer carries the reading the next read will; a create needs none, since a new container has no movement. */
async function readBack(tx: Tx, principal: Principal, id: string): Promise<ContainerRow> {
  const row = await findContainer(tx, principal, id)
  if (row === undefined) throw new Error(`container ${id} was written and is not there to read back`)
  return row
}

/** Registers a container in one of the caller's projects. A container just registered has no movement, so its state is null by construction and needs no probe. */
export async function createContainer(tx: Tx, principal: Principal, values: ContainerCreate): Promise<Container> {
  requireProject(principal, values.projectId)
  await requireContainerType(tx, principal.companyId, values.containerTypeId)
  const [row] = await refuseDuplicate({ [LABEL_TAKEN]: labelTaken(values.label) }, () =>
    tx
      .insert(container)
      .values({ ...values, id: newId(), companyId: principal.companyId })
      .returning(containerColumns),
  )
  return containerOf({ ...row, ...NO_STATE })
}

/**
 * Corrects one container of the caller's projects. The row first, then what
 * the patch points at: an id nobody minted is a 404 here as in every other
 * family, and not a 400 about a type that was never going to be written.
 */
export async function patchContainer(tx: Tx, principal: Principal, id: string, patch: ContainerPatch): Promise<Container> {
  if ((await findContainer(tx, principal, id)) === undefined) throw noSuchContainer(id)
  await requireContainerType(tx, principal.companyId, patch.containerTypeId)
  const sentences: Record<string, string> = patch.label === undefined ? {} : { [LABEL_TAKEN]: labelTaken(patch.label) }
  const [row] = await refuseDuplicate(sentences, () =>
    tx
      .update(container)
      .set(patch)
      .where(and(containerScope(principal), eq(container.id, id)))
      .returning({ id: container.id }),
  )
  if (row === undefined) throw noSuchContainer(id)
  return containerOf(await readBack(tx, principal, row.id))
}

/** The company's container with this label, in whichever project it is, with that project; undefined when the company has none. A label is the company's, so a match outside the caller's projects is the import's to refuse, not to miss. */
export async function containerByLabel(tx: Tx, companyId: string, label: string): Promise<{ id: string; projectId: string } | undefined> {
  const [row] = await tx
    .select({ id: container.id, projectId: container.projectId })
    .from(container)
    .where(and(eq(container.companyId, companyId), eq(container.label, label)))
    .limit(1)
  return row
}
