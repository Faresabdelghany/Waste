// What every create answers, read the way a client reads it (Issue #74). A
// route suite's own `create` helper posts the body and hands the response
// here, so the three things a create promises are asserted in one place and
// on every create the suites make:
//
//   201             — and the body, as the contracts schema parses it;
//   Location        — the row's own single-row GET, relative to the origin:
//                     the collection the body was posted to under the id the
//                     server minted. That collection is the last segment of
//                     the request path even for the two nested creates, since
//                     a subscription posted under `/agreements/:id/subscriptions`
//                     is read at `/subscriptions/:id` and a placement under
//                     `/containers/:id/placements` at `/placements/:id`;
//   and it resolves — the header is followed as the same caller, so what it
//                     names is proven an address and not a string: 200, and
//                     the same id.
import assert from "node:assert/strict"

import type { Call } from "./calls"

type Schema<T> = { parse: (value: unknown) => T }

/** Asserts the create answered as above and hands back the body; `path` is the path the body was posted to. */
export async function created<T extends { id: string }>(call: Call, path: string, response: Response, schema: Schema<T>): Promise<T> {
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  const body = schema.parse(await response.json())
  const location = response.headers.get("location") ?? ""
  assert.equal(location, `/${path.split("/").at(-1)}/${body.id}`, `Location of POST ${path}`)
  const read = await call(location)
  assert.equal(read.status, 200, `GET ${location}: ${JSON.stringify(await read.clone().json())}`)
  assert.equal(schema.parse(await read.json()).id, body.id, `GET ${location} is the row that was made`)
  return body
}
