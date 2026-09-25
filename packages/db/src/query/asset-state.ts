// The Container Asset State as a query (Issue #101, ADR-0003): the latest
// Stock Movement of each container, folded onto one of the glossary's four
// states. Nothing stores it — "never independently writable; no API writes
// it" — so every route that answers a Container left-joins this subquery and
// reads the state off the row it finds, the way a placement's effective
// cadence is a coalesce on every read.
//
//   const state = assetStateOf(tx, principal.companyId)
//   tx.select({ ...columns, assetStatus: assetStatus(state.toKind), ... })
//     .from(container)
//     .leftJoin(state, and(eq(state.companyId, container.companyId), eq(state.containerId, container.id)))
//
// The fold is in recording order — `distinct on (container_id) ... order by
// container_id, id desc`, the id being a UUIDv7 and so the order the rows
// were made in — and not by `occurred_at`. A command holds every movement's
// `from` to the place the previous one arrived at, under the container's row
// lock, so the chain is consistent by construction only in the order it was
// written; a back-dated return recorded after a transfer would otherwise put
// the container in a warehouse it had already left. `occurred_at` is
// evidence, carried on the row and listed, never the order. The subquery runs
// over `stock_movement_container_id_idx`, `(company_id, container_id, id)`.
//
// `assetStatus(toKind)` is the CASE that turns the place arrived at into the
// wire's status, built from the domain's `ASSET_STATUS_OF_PLACE` so the two
// cannot say different things, and a list can filter by status in SQL
// (`where assetStatus(state.toKind) = 'in-warehouse'`).
import { ASSET_STATUS_OF_PLACE } from "@waste/domain/resources/asset-state"
import type { AssetStatus } from "@waste/domain/resources/vocabulary"
import { desc, eq, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import type { Db } from "../client"
import { stockMovement } from "../schema/stock"

/** What the subquery yields per container: the latest movement's id, where it arrived, and when it happened. */
export const ASSET_STATE_COLUMNS = {
  companyId: stockMovement.companyId,
  containerId: stockMovement.containerId,
  movementId: stockMovement.id,
  toKind: stockMovement.toKind,
  toWarehouseId: stockMovement.toWarehouseId,
  placementId: stockMovement.placementId,
  occurredAt: stockMovement.occurredAt,
}

/** The alias the subquery joins under. */
export const ASSET_STATE = "asset_state"

/**
 * The latest movement per container of this company, as a subquery to
 * left-join onto `container` by `(company_id, id)`. `db` is the pool or the
 * request's transaction; the statement runs where the join runs.
 */
export function assetStateOf(db: Pick<Db, "selectDistinctOn">, companyId: string) {
  return db
    .selectDistinctOn([stockMovement.containerId], ASSET_STATE_COLUMNS)
    .from(stockMovement)
    .where(eq(stockMovement.companyId, companyId))
    .orderBy(stockMovement.containerId, desc(stockMovement.id))
    .as(ASSET_STATE)
}

/** A SQL string literal for a token: single quotes, quotes inside doubled. */
const literal = (value: string): SQL => sql.raw(`'${value.replaceAll("'", "''")}'`)

/** The pairs of the fold, in the domain's order, as `when 'warehouse' then 'in-warehouse'`. */
const folds = Object.entries(ASSET_STATUS_OF_PLACE).map(([place, status]) => sql`when ${literal(place)} then ${literal(status)}`)

/** The status a `to_kind` folds onto, as a CASE over the domain's table; null for a null `to_kind` (a container with no movement) and for a place nothing arrives at. */
export function assetStatus(toKind: PgColumn | SQL): SQL<AssetStatus | null> {
  return sql<AssetStatus | null>`case ${toKind} ${sql.join(folds, sql` `)} else null end`
}
