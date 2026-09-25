// The keys of a tenant's table, and the Data model rule they carry: an
// intra-tenant reference is a composite foreign key that includes the tenant,
// `(company_id, role_id) → role (company_id, id)`, so a row cannot point at
// another company's record whatever the API does; the referenced table carries
// `unique (company_id, id)` for it to point at; and only `company_id → company
// (id)` itself is a plain key. Every name goes through names.ts, which refuses
// one Postgres would truncate: drizzle-kit's default for a foreign key,
// `<table>_<columns>_<foreign table>_<foreign columns>_fk`, overruns 63 bytes
// on a composite key and Postgres would cut it silently.
//
// Where both tables are project-scoped the key carries the project too:
// `(company_id, project_id, property_id) → property (company_id, project_id,
// id)`, so a subscription cannot name a property of another project any more
// than of another company (Issue #78). The referenced table carries `unique
// (company_id, project_id, id)` for it. A reference from a project-scoped
// table to a company-wide one — a placement's waste fraction, an agreement's
// customer — stays a `tenantReference`: the target has no project to agree on.
//
// A reference may reach its row through another column of the target as well
// (Issue #101): the Stock Movement ledger names a placement *of the container
// it moves*, so its key is `(company_id, project_id, container_id,
// placement_id) → container_service_placement (company_id, project_id,
// container_id, id)`, and container A cannot be recorded as issued into
// container B's placement whatever the API does. That is `projectReference`
// with the wider `foreign` columns, pointing at `projectKey(t, t.containerId)`,
// `unique (company_id, project_id, container_id, id)`, named
// `<table>_<through>_project_key`.
//
// The names. A foreign key is `<table>_<its columns>_fk`, a unique constraint
// `<table>_<its columns>_key` (Postgres's own suffix for one), an index
// `<table>_<its columns>_idx` (with or without the tenant: `tenantIndex` and
// `indexOn`), `company_id` and `project_id` left out of a
// key's name since every key of a tenant's table begins with the one and every
// project-scoped key with both, `unique (company_id, id)` is
// `<table>_tenant_key` and `unique (company_id, project_id, id)`
// `<table>_project_key`, the keys the composite references point at. Postgres
// names the constraint in its refusal (23503, 23505), so the name says which
// columns were at fault.
//
// The helpers take the columns object of the table's extra-config callback:
//
//   export const project = wms.table("project", { ...id, ...tenant, ...timestamps, name: text().notNull() }, (t) => [
//     companyReference(t, company),
//     tenantUnique(t, t.name),
//     tenantKey(t),
//   ])
//
// A foreign key is checked with Postgres's default action, NO ACTION: a
// referenced row cannot be deleted while a row points at it, and nothing
// cascades. Every referencing column set has an index (a unique constraint is
// one; `tenantIndex` adds one where no unique leads with the columns), since
// Postgres indexes the referenced side only and would otherwise scan the
// referencing table on every delete of a parent.
import { getTableName } from "drizzle-orm"
import { foreignKey, index, unique, type ForeignKeyBuilder, type IndexBuilder, type PgColumn, type UniqueConstraintBuilder } from "drizzle-orm/pg-core"

import { columnName, quoted, tableObjectName } from "../names"

/** A table's extra-config columns, as far as these helpers read them: every domain table carries `company_id`. */
export type TenantColumns = { companyId: PgColumn }
/** A table a composite reference can point at: `company_id` and `id`, with `tenantKey` in its extra config. */
export type TenantTable = TenantColumns & { id: PgColumn }
/** A project-scoped table's extra-config columns: it spread `projectScoped`, so it carries `project_id` beside `company_id`. */
export type ProjectColumns = TenantColumns & { projectId: PgColumn }
/** A table a project-scoped reference can point at: `company_id`, `project_id` and `id`, with `projectKey` in its extra config. */
export type ProjectTable = TenantTable & { projectId: PgColumn }

/** The columns' database names joined, for the object's name. */
const named = (columns: PgColumn[]): string => columns.map(columnName).join("_")

/**
 * The column's table, spelled for a refusal. These helpers run inside the
 * table's extra-config builder, so they cannot read its config (getTableConfig
 * runs the builder again, without end); the name is what there is.
 */
const tableOf = (column: PgColumn): string => quoted(getTableName(column.table))

/** `company_id → company (id)`, the one plain foreign key of a domain table, named `<table>_company_id_fk`. */
export function companyReference(columns: TenantColumns, company: { id: PgColumn }): ForeignKeyBuilder {
  return foreignKey({
    name: tableObjectName(columns.companyId.table, `${columnName(columns.companyId)}_fk`, "companyReference"),
    columns: [columns.companyId],
    foreignColumns: [company.id],
  })
}

/**
 * `(company_id, ...own) → target (company_id, ...foreign)`, named
 * `<table>_<own>_fk`. `foreign` is the target's `id` unless the reference
 * points at a wider key (`user_account (company_id, id, service_provider_id)`).
 */
export function tenantReference(columns: TenantColumns, own: PgColumn[], target: TenantTable, foreign: PgColumn[] = [target.id]): ForeignKeyBuilder {
  const helper = "tenantReference"
  if (own.length === 0) {
    throw new Error(`${helper}: ${tableOf(columns.companyId)} names no columns beside company_id`)
  }
  if (own.length !== foreign.length) {
    throw new Error(`${helper}: ${tableOf(columns.companyId)} names ${own.length} column(s) for a key of ${foreign.length} in ${tableOf(target.companyId)}`)
  }
  return foreignKey({
    name: tableObjectName(columns.companyId.table, `${named(own)}_fk`, helper),
    columns: [columns.companyId, ...own],
    foreignColumns: [target.companyId, ...foreign],
  })
}

/**
 * `(company_id, project_id, ...own) → target (company_id, project_id, ...foreign)`,
 * named `<table>_<own>_fk` like `tenantReference`: for a reference between two
 * project-scoped tables, which cannot cross a project either. `foreign` is
 * the target's `id` unless the reference reaches the row through another of
 * its columns as well (`[placement.containerId, placement.id]`, pointing at
 * `projectKey(t, t.containerId)`).
 */
export function projectReference(columns: ProjectColumns, own: PgColumn[], target: ProjectTable, foreign: PgColumn[] = [target.id]): ForeignKeyBuilder {
  const helper = "projectReference"
  if (own.length === 0) {
    throw new Error(`${helper}: ${tableOf(columns.companyId)} names no columns beside company_id and project_id`)
  }
  if (own.length !== foreign.length) {
    throw new Error(`${helper}: ${tableOf(columns.companyId)} names ${own.length} column(s) for a key of ${foreign.length} in ${tableOf(target.companyId)}`)
  }
  for (const column of foreign) {
    if (column.table !== target.id.table) {
      throw new Error(`${helper}: column "${columnName(column)}" is not a column of ${tableOf(target.id)}, the table the key points at`)
    }
  }
  return foreignKey({
    name: tableObjectName(columns.companyId.table, `${named(own)}_fk`, helper),
    columns: [columns.companyId, columns.projectId, ...own],
    foreignColumns: [target.companyId, target.projectId, ...foreign],
  })
}

/** `UNIQUE (company_id, id)`, named `<table>_tenant_key`: what a `tenantReference` points at. */
export function tenantKey(columns: TenantTable): UniqueConstraintBuilder {
  return unique(tableObjectName(columns.companyId.table, "tenant_key", "tenantKey")).on(columns.companyId, columns.id)
}

/**
 * `UNIQUE (company_id, project_id, ...through, id)`: what a `projectReference`
 * points at — `<table>_project_key` with no `through`, or
 * `<table>_<through>_project_key` when a reference reaches the row through
 * another of its columns as well, so the key it points at carries that column.
 */
export function projectKey(columns: ProjectTable, ...through: PgColumn[]): UniqueConstraintBuilder {
  const helper = "projectKey"
  for (const column of through) {
    if (column.table !== columns.id.table) {
      throw new Error(`${helper}: column "${columnName(column)}" is not a column of ${tableOf(columns.id)}`)
    }
  }
  const suffix = through.length === 0 ? "project_key" : `${named(through)}_project_key`
  return unique(tableObjectName(columns.companyId.table, suffix, helper)).on(columns.companyId, columns.projectId, ...through, columns.id)
}

/** `UNIQUE (company_id, ...own)`, named `<table>_<own>_key`: a business key, which is always the tenant's. */
export function tenantUnique(columns: TenantColumns, ...own: [PgColumn, ...PgColumn[]]): UniqueConstraintBuilder {
  return unique(tableObjectName(columns.companyId.table, `${named(own)}_key`, "tenantUnique")).on(columns.companyId, ...own)
}

/** `UNIQUE (...own)` without the tenant, named `<table>_<own>_key`: a key that holds across companies. */
export function uniqueOn(...own: [PgColumn, ...PgColumn[]]): UniqueConstraintBuilder {
  return unique(tableObjectName(own[0].table, `${named(own)}_key`, "uniqueOn")).on(...own)
}

/** `INDEX (company_id, ...own)`, named `<table>_<own>_idx`: for a referencing column set no unique constraint leads with. */
export function tenantIndex(columns: TenantColumns, ...own: [PgColumn, ...PgColumn[]]): IndexBuilder {
  return index(tableObjectName(columns.companyId.table, `${named(own)}_idx`, "tenantIndex")).on(columns.companyId, ...own)
}

/**
 * `INDEX (...own)` without the tenant, named `<table>_<own>_idx`: for a lookup
 * that crosses companies, which only the access token hook makes (an account
 * by its e-mail, on first sign-in). Every statement of the API's carries
 * `company_id` and reads through `tenantIndex` or a key.
 */
export function indexOn(...own: [PgColumn, ...PgColumn[]]): IndexBuilder {
  return index(tableObjectName(own[0].table, `${named(own)}_idx`, "indexOn")).on(...own)
}
