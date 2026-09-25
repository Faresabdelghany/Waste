// What a Registry suite writes when its test needs a record of another
// family in a given state (Issue #79): a Shared Collection Point in a status,
// and a status moved the way the record's own PATCH moves it. The point body
// was spelled in three files before it was here; the fields with no default
// are filled with what a made-up point needs and nothing a test asserts on.
import assert from "node:assert/strict"

import type { Call } from "./calls"

/** Copenhagen town hall, the point every located fixture sits on. */
export const TOWN_HALL = { type: "Point", coordinates: [12.5683, 55.6761] }

/** A shared collection point body in the status a test names: a municipal surface point, open to anybody, at an address made from its name. */
export const pointBody = (projectId: string, name: string, status: string) => ({
  projectId,
  name,
  kind: "surface",
  address: `${name}, 2100 København Ø`,
  location: TOWN_HALL,
  operatingModel: "municipal",
  accessMode: "open",
  billingMode: "municipal",
  status,
})

/** Moves a record to a status the way its own PATCH does: how a customer goes inactive, a property stops being served, a point closes or is drafted again. */
export async function setStatus(call: Call, path: string, status: string): Promise<void> {
  const response = await call(path, { method: "PATCH", body: { status } })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
}
