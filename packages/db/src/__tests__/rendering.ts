// How the rendering tests spell what drizzle-kit writes, once: the column sets
// a table begins with, a CREATE TABLE, a foreign key, an index, a unique, and
// each check helper's constraint as it lands in the migration file. Three
// suites pin three contexts' DDL against these (organisation-access-rendering,
// registry-rendering, planning-rendering) and each had a copy; a copied
// helper is a copy that can quietly stop spelling the same thing. Every string
// here is byte for byte what the copies said.
//
// `checksOf` reads a table's checks through drizzle-kit's dialect with the
// package's casing, and refuses one that carries a parameter, since the
// migration file cannot say `$1`.
//
// Not a suite of its own: the runner takes `src/**/*.test.ts`, so this file is
// only ever imported.
import assert from "node:assert/strict"

import { getTableConfig, PgDialect } from "drizzle-orm/pg-core"

import { CASING } from "../casing"

export const ID = '"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL'
export const COMPANY = '"company_id" uuid NOT NULL'
export const PROJECT = '"project_id" uuid NOT NULL'
export const STAMPS = ['"created_at" timestamp with time zone DEFAULT now() NOT NULL', '"updated_at" timestamp with time zone DEFAULT now() NOT NULL']
export const VALIDITY = ['"valid_from" date NOT NULL', '"valid_to" date']
/** The column sets a table begins with, by the sets it spreads. */
export const SETS = {
  tenant: [ID, COMPANY, ...STAMPS],
  project: [ID, COMPANY, PROJECT, ...STAMPS],
  dated: [ID, COMPANY, PROJECT, ...STAMPS, ...VALIDITY],
}

/** One CREATE TABLE as drizzle-kit writes it: the sets, then the table's own lines, one per tab-indented line and the last without a comma. */
export const createTable = (name: string, sets: keyof typeof SETS, lines: string[]): string =>
  [`CREATE TABLE "wms"."${name}" (`, [...SETS[sets], ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

export const ref = (table: string, column: string): string => `"wms"."${table}"."${column}"`
export const columns = (...names: string[]): string => names.map((name) => `"${name}"`).join(",")
export const foreignKey = (table: string, name: string, own: string[], target: string, foreign: string[]): string =>
  `ALTER TABLE "wms"."${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (${columns(...own)}) REFERENCES "wms"."${target}"(${columns(...foreign)}) ON DELETE no action ON UPDATE no action;`
export const index = (table: string, name: string, ...own: string[]): string => `CREATE INDEX "${name}" ON "wms"."${table}" USING btree (${columns(...own)});`
export const gistIndex = (table: string, name: string, column: string): string => `CREATE INDEX "${name}" ON "wms"."${table}" USING gist (${columns(column)});`
export const partialUniqueIndex = (table: string, name: string, own: string[], where: string): string =>
  `CREATE UNIQUE INDEX "${name}" ON "wms"."${table}" USING btree (${columns(...own)}) WHERE ${where};`

/** The tenant's plain key and the project-scoped one, which every project-scoped table carries. */
export const companyFk = (table: string): string => foreignKey(table, `${table}_company_id_fk`, ["company_id"], "company", ["id"])
export const projectFk = (table: string): string => foreignKey(table, `${table}_project_id_fk`, ["company_id", "project_id"], "project", ["company_id", "id"])
export const tenantFk = (table: string, column: string, target: string): string =>
  foreignKey(table, `${table}_${column}_fk`, ["company_id", column], target, ["company_id", "id"])
export const projectFkTo = (table: string, column: string, target: string): string =>
  foreignKey(table, `${table}_${column}_fk`, ["company_id", "project_id", column], target, ["company_id", "project_id", "id"])

export const uniqueKey = (name: string, ...own: string[]): string => `CONSTRAINT "${name}" UNIQUE(${columns(...own)})`
/** A list of literals as a check spells them: `'a', 'b'`. */
export const list = (...values: string[]): string => values.map((value) => `'${value}'`).join(", ")
export const oneOfCheck = (table: string, column: string, ...values: string[]): string =>
  `CONSTRAINT "${table}_${column}_one_of" CHECK (${ref(table, column)} in (${list(...values)}))`
export const subsetCheck = (table: string, column: string, ...values: string[]): string =>
  `CONSTRAINT "${table}_${column}_subset_of" CHECK (${ref(table, column)} <@ ARRAY[${list(...values)}]::text[])`
export const nonEmptyCheck = (table: string, column: string): string => `CONSTRAINT "${table}_${column}_non_empty" CHECK (cardinality(${ref(table, column)}) > 0)`
export const positiveCheck = (table: string, column: string): string => `CONSTRAINT "${table}_${column}_positive" CHECK (${ref(table, column)} > 0)`
export const lowercaseCheck = (table: string, column: string): string =>
  `CONSTRAINT "${table}_${column}_lowercase" CHECK (${ref(table, column)} = lower(${ref(table, column)}))`
export const validityCheck = (table: string): string =>
  `CONSTRAINT "${table}_validity" CHECK (${ref(table, "valid_to")} is null or ${ref(table, "valid_to")} > ${ref(table, "valid_from")})`
export const geometryCheck = (table: string, column: string): string => {
  const it = ref(table, column)
  return `CONSTRAINT "${table}_${column}_valid" CHECK (extensions.st_isvalid(${it}) and not extensions.st_isempty(${it}) and extensions.st_xmin(${it}) >= -180 and extensions.st_xmax(${it}) <= 180 and extensions.st_ymin(${it}) >= -90 and extensions.st_ymax(${it}) <= 90)`
}

const dialect = new PgDialect({ casing: CASING })
/** The SQL of a table's checks by name, as drizzle-kit renders it into the migration: no parameters, or the file would say `$1`. */
export const checksOf = (table: Parameters<typeof getTableConfig>[0]): Map<string, string> =>
  new Map(
    getTableConfig(table).checks.map((check) => {
      const query = dialect.sqlToQuery(check.value)
      assert.deepEqual(query.params, [], `${check.name} carries a parameter, which the migration file cannot`)
      return [check.name, query.sql]
    }),
  )
