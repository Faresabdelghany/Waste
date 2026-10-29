// What a code read off a bin names, in SQL (O19 of #290): the containers one
// of whose four identifiers — the label, the barcode, the RFID tag, the
// serial number — spells it, compared as @waste/domain/registry/
// container-identity compares them, spaces either side dropped and the case
// ignored, so the office's lookup, the driver's and the arrival's judgement
// agree with the domain on what matches. No index serves it: a company's
// containers are read under its own `company_id` index, and a lookup is one
// tap's read.
import { normaliseCode } from "@waste/domain/registry/container-identity"
import { or, sql, type AnyColumn, type SQL } from "drizzle-orm"

/** A container's four identifier columns: the table's, or an alias's. */
export type IdentifierColumns = { label: AnyColumn; barcode: AnyColumn; rfid: AnyColumn; serialNumber: AnyColumn }

/** Whether the container's row — the table or an alias of it — is one the code names. */
export function namedByCode(table: IdentifierColumns, code: string): SQL {
  const wanted = normaliseCode(code)
  const spells = (column: AnyColumn): SQL => sql`upper(btrim(${column})) = ${wanted}`
  // Four columns, so `or` is never empty.
  return or(spells(table.label), spells(table.barcode), spells(table.rfid), spells(table.serialNumber)) as SQL
}
