// The Container Asset State as a query (Issue #101, ADR-0003): the latest
// Stock Movement of a container, folded onto one of the glossary's four
// states. Nothing stores it — "never independently writable; no API writes
// it" — so every route that answers a Container joins this lookup and reads
// the state off the row it finds, the way a placement's effective cadence is
// a coalesce on every read.
//
//   const state = assetStateOf(tx, principal.companyId, container.id)
//   tx.select({ ...columns, assetStatus: assetStatus(state.toKind), ... })
//     .from(container)
//     .leftJoinLateral(state, sql`true`)
//
// A LATERAL lookup per row, not a fold of the whole ledger: `select … from
// stock_movement where company_id = ? and container_id = <the row's id> order
// by id desc limit 1`, one probe into `stock_movement_container_id_idx`
// (`(company_id, container_id, id desc)`) for each container the outer query
// answers, so a page of fifty costs fifty probes and never a `DISTINCT ON`
// over every movement the company ever recorded.
//
// The fold is in recording order — the id, a UUIDv7, is the order the rows
// were made in — and not by `occurred_at`. A command holds every movement's
// `from` to the place the previous one arrived at, under the container's row
// lock, so the chain is consistent by construction only in the order it was
// written; a back-dated return recorded after a transfer would otherwise put
// the container in a warehouse it had already left. `occurred_at` is
// evidence, carried on the row and listed, never the order.
//
// `assetStatus(toKind)` is the CASE that turns the place arrived at into the
// wire's status, built from the domain's `ASSET_STATUS_OF_PLACE` so the two
// cannot say different things, and a list can filter by status in SQL
// (`where assetStatus(state.toKind) = 'in-warehouse'`).
import { ASSET_STATUS_OF_PLACE } from "@waste/domain/resources/asset-state"
import type { AssetStatus } from "@waste/domain/resources/vocabulary"
import { and, desc, eq, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import type { Db } from "../client"
import { literal } from "../schema/checks"
import { stockMovement } from "../schema/stock"

/** What the lookup yields for a container: its latest movement's id, where it arrived, and when it happened. */
export const ASSET_STATE_COLUMNS = {
  movementId: stockMovement.id,
  toKind: stockMovement.toKind,
  toWarehouseId: stockMovement.toWarehouseId,
  placementId: stockMovement.placementId,
  occurredAt: stockMovement.occurredAt,
}

/** The alias the lookup joins under. */
export const ASSET_STATE = "asset_state"

/**
 * The latest movement of the container `containerId` names — the outer
 * query's `container.id` — as a subquery to `leftJoinLateral` onto
 * `container`, `sql\`true\`` being the join's condition since the correlation
 * is inside. `db` is the pool or the request's transaction; the statement
 * runs where the join runs.
 */
export function assetStateOf(db: Pick<Db, "select">, companyId: string, containerId: PgColumn | SQL) {
  return db
    .select(ASSET_STATE_COLUMNS)
    .from(stockMovement)
    .where(and(eq(stockMovement.companyId, companyId), eq(stockMovement.containerId, containerId)))
    .orderBy(desc(stockMovement.id))
    .limit(1)
    .as(ASSET_STATE)
}

/** The pairs of the fold, in the domain's order, as `when 'warehouse' then 'in-warehouse'`. */
const folds = Object.entries(ASSET_STATUS_OF_PLACE).map(([place, status]) => sql`when ${sql.raw(literal(place))} then ${sql.raw(literal(status))}`)

/** The status a `to_kind` folds onto, as a CASE over the domain's table; null for a null `to_kind` (a container with no movement) and for a place nothing arrives at. */
export function assetStatus(toKind: PgColumn | SQL): SQL<AssetStatus | null> {
  return sql<AssetStatus | null>`case ${toKind} ${sql.join(folds, sql` `)} else null end`
}
