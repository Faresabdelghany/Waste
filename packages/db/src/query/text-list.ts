// A constant list of text in a raw statement (Issue #152): the client's
// serialisers take no JS array (Drizzle rewires them, client.ts), so the list
// travels as one JSON parameter and becomes a `text[]` in the statement:
// `where rolname = any(${textList(sql, roles)})`.
import type { PendingQuery, Row, Sql } from "postgres"

export const textList = (sql: Sql, values: readonly string[]): PendingQuery<Row[]> => sql`array(select json_array_elements_text(${JSON.stringify(values)}::json))`
