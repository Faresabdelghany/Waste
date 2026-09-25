// The container ledger (Issue #101, ADR-0003): `stock_movement`, the first
// append-only table of the system. Every row says one container went from one
// place to another — a supplier, a warehouse, maintenance at a warehouse, a
// service placement, scrap — when, why, on whose word. Rows are inserted and
// never updated or deleted: the table spreads `recorded` instead of
// `timestamps`, carries no trigger, and its migration file revokes UPDATE and
// DELETE from the API role (sql/append-only.ts); the owner keeps both, for
// tests and for erasure.
//
// The Container Asset State is a query over it and not a table
// (query/asset-state.ts): the latest movement of each container in recording
// order, folded onto the glossary's four states by
// @waste/domain/resources/asset-state. Nothing writes the state, because
// there is nothing to write. The rule the ledger holds — a container is in
// one place at a time and every movement leaves from where the container is
// — is the API's, under the container's row lock: a command reads the state
// and refuses a movement whose `from` is not the current place, so the chain
// never forks. Recording order and not `occurred_at`, since the chain is
// consistent only in the order the commands checked it; `occurred_at` is
// evidence, carried and listed, never the order.
//
// The places are typed columns and not a polymorphic `place_id`:
// `from_warehouse_id`, `to_warehouse_id` and `placement_id` are foreign keys
// the database checks, where one `uuid` for four kinds of place would be a
// key nothing checks. A supplier and scrap have no row, which the shape
// checks hold; maintenance is a place kind at a warehouse (`to_kind =
// 'maintenance'` with the workshop's `to_warehouse_id`), not a table. Four
// shape checks, spelled inline and named for the rule: a warehouse id goes
// with a warehouse or maintenance kind on each side (`_from_shape`,
// `_to_shape`), a placement goes with a service kind on either side
// (`_placement_shape`), and `_kind_shape` is a CASE over the kind spelling
// the pairs the vocabulary allows — the same table `movementShape` spells in
// the domain, and a test runs every pair through both, so the API refuses a
// nonsense command with a sentence before the check does with a code.
//
// The ledger references the Registry's placement through the container it
// moves: `(company_id, project_id, container_id, placement_id) →
// container_service_placement (company_id, project_id, container_id, id)`,
// which is why the placement gained `projectKey(t, t.containerId)` in 0007 —
// so container A cannot be recorded as issued into container B's placement,
// whatever the API does. It references itself through `corrects_movement_id`,
// the adjustment's pointer at the row it corrects, for which it carries
// `tenantKey`. The index the fold reads is `(company_id, container_id, id)`,
// spelled inline since `tenantIndex` would derive `_container_id_id_idx`:
// query/asset-state.ts looks the latest movement of one container up per row,
// `where company_id = ? and container_id = ? order by id desc limit 1`, which
// the planner serves as one backward probe into this ascending index. It is
// not declared descending on purpose: drizzle-kit renders `DESC` as `DESC
// NULLS LAST`, while `ORDER BY id DESC` means nulls first, and the mismatch
// costs a sort where the plain index gives an Index Scan Backward.
import { STOCK_MOVEMENT_KINDS, STOCK_PLACE_KINDS } from "@waste/domain/resources/vocabulary"
import { sql } from "drizzle-orm"
import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf } from "./checks"
import { id, projectScoped, recorded } from "./columns"
import { container, containerServicePlacement } from "./containers"
import { company, project } from "./organisation"
import { warehouse } from "./places"
import { companyReference, projectReference, tenantIndex, tenantKey, tenantReference } from "./references"
import { wms } from "./wms"

export const stockMovement = wms.table(
  "stock_movement",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    containerId: uuid().notNull(),
    kind: text().notNull(),
    fromKind: text().notNull(),
    /** Where it left from, when that is a warehouse or maintenance at one. */
    fromWarehouseId: uuid(),
    toKind: text().notNull(),
    /** Where it arrived, when that is a warehouse or maintenance at one. */
    toWarehouseId: uuid(),
    /** The placement an issue opens or a return or decommission closes. */
    placementId: uuid(),
    /** When it happened, on the person's word; evidence, never the order the chain is folded in. */
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    /** The caller's account. */
    recordedBy: uuid().notNull(),
    reason: text(),
    /** A delivery note, a ticket. */
    reference: text(),
    /** The movement an adjustment corrects, if it corrects one. */
    correctsMovementId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.fromWarehouseId], warehouse),
    projectReference(t, [t.toWarehouseId], warehouse),
    // The placement of this container and no other: the key carries the container on both sides.
    projectReference(t, [t.containerId, t.placementId], containerServicePlacement, [containerServicePlacement.containerId, containerServicePlacement.id]),
    tenantReference(t, [t.recordedBy], userAccount),
    // The ledger's own key, for the pointer at the row an adjustment corrects: the same table on both sides.
    tenantReference(t, [t.correctsMovementId], t),
    tenantKey(t),
    oneOf(t.kind, STOCK_MOVEMENT_KINDS),
    oneOf(t.fromKind, STOCK_PLACE_KINDS),
    oneOf(t.toKind, STOCK_PLACE_KINDS),
    // A warehouse is named exactly when the side is a warehouse or maintenance at one; a placement exactly when a side is service.
    check(tableObjectName(t.id.table, "from_shape", "stockMovement"), sql`(${t.fromKind} in ('warehouse', 'maintenance')) = (${t.fromWarehouseId} is not null)`),
    check(tableObjectName(t.id.table, "to_shape", "stockMovement"), sql`(${t.toKind} in ('warehouse', 'maintenance')) = (${t.toWarehouseId} is not null)`),
    check(tableObjectName(t.id.table, "placement_shape", "stockMovement"), sql`(${t.fromKind} = 'service' or ${t.toKind} = 'service') = (${t.placementId} is not null)`),
    // The pairs each kind allows: the table @waste/domain/resources/asset-state spells as MOVEMENT_SHAPES, as one CASE.
    check(
      tableObjectName(t.id.table, "kind_shape", "stockMovement"),
      sql`case ${t.kind} when 'receipt' then ${t.fromKind} = 'supplier' and ${t.toKind} = 'warehouse' when 'issue' then ${t.fromKind} in ('warehouse', 'maintenance') and ${t.toKind} = 'service' when 'return' then ${t.fromKind} = 'service' and ${t.toKind} in ('warehouse', 'maintenance') when 'transfer' then ${t.fromKind} in ('warehouse', 'maintenance') and ${t.toKind} in ('warehouse', 'maintenance') when 'decommission' then ${t.fromKind} in ('warehouse', 'maintenance', 'service') and ${t.toKind} = 'scrap' when 'adjustment' then ${t.fromKind} <> 'service' and ${t.toKind} in ('warehouse', 'maintenance', 'scrap') else false end`,
    ),
    // The fold reads the latest row of one container: `where company_id = ? and container_id = ? order by id desc limit 1`, one backward probe into this index (ascending on purpose, see the header).
    index(tableObjectName(t.companyId.table, "container_id_idx", "stockMovement")).on(t.companyId, t.containerId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.fromWarehouseId),
    tenantIndex(t, t.toWarehouseId),
    tenantIndex(t, t.placementId),
    tenantIndex(t, t.recordedBy),
    tenantIndex(t, t.correctsMovementId),
  ],
)
