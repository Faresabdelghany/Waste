// A Property's parties dated (#374, the `dated_parties` migration): a party
// holds its role from `valid_from`, and the rows written before the column
// existed take the day each was written on its project's clock — the best the
// table knows of when the role began, since `PUT /properties/:id/parties`
// rewrote the set whole until then. The migration adds the column nullable,
// runs this backfill, and only then makes it NOT NULL; drizzle-kit's one
// `ADD COLUMN … NOT NULL` would refuse a database holding parties.
// dated-parties-rendering.test.ts pins the statements byte for byte in the file.

/** The statement that gives every party written before #374 the day it was written, on its project's clock. */
export function datedPartiesBackfill(): string {
  return (
    `UPDATE "wms"."property_party" AS pp SET "valid_from" = (pp."created_at" AT TIME ZONE p."timezone")::date ` +
    `FROM "wms"."project" AS p ` +
    `WHERE p."company_id" = pp."company_id" AND p."id" = pp."project_id";`
  )
}

/** The statement that holds every party to its first day once the backfill has given each one. */
export function datedPartiesRequired(): string {
  return `ALTER TABLE "wms"."property_party" ALTER COLUMN "valid_from" SET NOT NULL;`
}
