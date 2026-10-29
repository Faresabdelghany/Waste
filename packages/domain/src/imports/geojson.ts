// A GeoJSON file read for the planning areas' import (O30 of #290, row 1.18):
// a FeatureCollection, each Feature an area — its properties the columns,
// matched by `headerKey` as a CSV header is, and its geometry the boundary —
// read into the rows the CSV reader makes (./csv), so the preview, the run and
// the ledger are the import's own. A property the kind does not know is left
// out rather than refused: a GIS export carries many, and the area's are the
// ones named. A Polygon is the boundary as it stands, and a MultiPolygon of one
// polygon that polygon; any other geometry is no boundary, which the row then
// says by lacking one. Rows are numbered from 2, the first feature row 2, so a
// refusal names a row as a spreadsheet's would.

import { columnOf, IMPORT_COLUMNS } from "./columns"
import type { ImportFile, ImportRow } from "./csv"

/** What a file that is not a GeoJSON FeatureCollection is told. */
export const NOT_A_FEATURE_COLLECTION = "The file is not a GeoJSON FeatureCollection: export the areas as one, each a Feature with its code, name and purpose"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** The polygon a feature's geometry is, as the boundary's GeoJSON; undefined where it is none. */
function boundaryOf(geometry: unknown): string | undefined {
  if (!isObject(geometry)) return undefined
  if (geometry.type === "Polygon") return JSON.stringify({ type: "Polygon", coordinates: geometry.coordinates })
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates) && geometry.coordinates.length === 1) return JSON.stringify({ type: "Polygon", coordinates: geometry.coordinates[0] })
  return undefined
}

/** A property's value as a cell: a string trimmed, a number spelt, anything else no cell. */
const cellOf = (value: unknown): string | undefined => (typeof value === "string" ? value.trim() || undefined : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)

/** The rows of a GeoJSON text for the planning areas' import, or the sentence a file that is not one is told. */
export function planningAreaRows(text: string): ImportFile | { problem: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""))
  } catch {
    return { problem: NOT_A_FEATURE_COLLECTION }
  }
  if (!isObject(parsed) || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) return { problem: NOT_A_FEATURE_COLLECTION }
  const seen = new Set<string>()
  const rows: ImportRow[] = parsed.features.map((feature, index) => {
    const values: Record<string, string> = {}
    if (isObject(feature)) {
      for (const [key, value] of Object.entries(isObject(feature.properties) ? feature.properties : {})) {
        const column = columnOf("planning-areas", key)
        const cell = cellOf(value)
        if (column === undefined || column.header === "boundary" || cell === undefined) continue
        values[column.header] = cell
        seen.add(column.header)
      }
      const boundary = boundaryOf(feature.geometry)
      if (boundary !== undefined) values.boundary = boundary
    }
    return { row: index + 2, values }
  })
  // A required column is missing when no feature names it: the header row a GeoJSON file does not have.
  const missing = rows.length === 0 ? [] : IMPORT_COLUMNS["planning-areas"].filter((column) => column.required && !seen.has(column.header)).map((column) => column.header)
  return { rows, issues: { unknown: [], missing, repeated: [], unclosedQuote: null } }
}
