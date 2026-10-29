// Driver messaging (O24 of #290) as drizzle-kit writes it: one new table, the
// Route Messages the office and the route's driver write about one route — a
// ledger keyed into the route and the driver through their project and into
// the account that sent it, a driver's naming its profile and the office's
// none. Then the migration, which is exactly those statements under its
// header, then what the ledger owes the file: its fence and its revoke. The
// file is found by its name, not its number, which it takes at its turn. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { routeMessage } from "../schema/route-messages"
import { appendOnly } from "../sql/append-only"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { checksOf, ref } from "./rendering"
import { statementsFor } from "./specimen"

const handWritten = [...tenantFence(routeMessage), ...appendOnly(routeMessage)]

async function fileText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_driver_messaging\.sql$/.test(name))
  assert.ok(file !== undefined, "the driver messaging migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the route messages as drizzle-kit writes them", () => {
  test("a message keys into its route and its driver through the project, and is the office's or the driver's", async () => {
    const statements = await statementsFor({ routeMessage })
    assert.ok(statements.includes('ALTER TABLE "wms"."route_message" ADD CONSTRAINT "route_message_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;'))
    assert.ok(statements.includes('CREATE INDEX "route_message_route_id_idx" ON "wms"."route_message" USING btree ("company_id","route_id","id");'), "a thread in the order it was written")
    const checks = checksOf(routeMessage)
    assert.equal(checks.get("route_message_author_one_of"), `${ref("route_message", "author")} in ('office', 'driver')`)
    assert.equal(checks.get("route_message_author_shape"), `(${ref("route_message", "author")} = 'driver') = (${ref("route_message", "driver_id")} is not null)`)
  })
})

describe("the driver messaging migration", () => {
  test("begins with exactly what drizzle-kit generates for it, under its header", async () => {
    const text = await fileText()
    const head = (await statementsFor({ routeMessage })).map(normalised)
    assert.deepEqual(statementsOf(text).slice(0, head.length).sort(), [...head].sort())
    assert.match(text, /^-- Driver messaging \(O24 of #290\)/)
  })

  test("and carries below them the ledger's fence and revoke, and nothing else", async () => {
    const statements = statementsOf(await fileText())
    const head = (await statementsFor({ routeMessage })).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
  })
})
