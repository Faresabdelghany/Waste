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
// The names. A foreign key is `<table>_<its columns>_fk`, a unique constraint
// `<table>_<its columns>_key` (Postgres's own suffix for one), an index
// `<table>_<its columns>_idx`, `company_id` and `project_id` left out of a
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
 * `(company_id, project_id, ...own) → target (company_id, project_id, id)`,
 * named `<table>_<own>_fk` like `tenantReference`: for a reference between two
 * project-scoped tables, which cannot cross a project either.
 */
export function projectReference(columns: ProjectColumns, own: PgColumn[], target: ProjectTable): ForeignKeyBuilder {
  const helper = "projectReference"
  if (own.length === 0) {
    throw new Error(`${helper}: ${tableOf(columns.companyId)} names no columns beside company_id and project_id`)
  }
  return foreignKey({
    name: tableObjectName(columns.companyId.table, `${named(own)}_fk`, helper),
    columns: [columns.companyId, columns.projectId, ...own],
    foreignColumns: [target.companyId, target.projectId, target.id],
  })
}

/** `UNIQUE (company_id, id)`, named `<table>_tenant_key`: what a `tenantReference` points at. */
export function tenantKey(columns: TenantTable): UniqueConstraintBuilder {
  return unique(tableObjectName(columns.companyId.table, "tenant_key", "tenantKey")).on(columns.companyId, columns.id)
}

/** `UNIQUE (company_id, project_id, id)`, named `<table>_project_key`: what a `projectReference` points at. */
export function projectKey(columns: ProjectTable): UniqueConstraintBuilder {
  return unique(tableObjectName(columns.companyId.table, "project_key", "projectKey")).on(columns.companyId, columns.projectId, columns.id)
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
