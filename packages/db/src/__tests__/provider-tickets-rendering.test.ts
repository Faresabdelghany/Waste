// A Service Provider's tickets (#291 slice 23b) as drizzle-kit writes them:
// `ticket_source_one_of` and `ticket_event_visibility_one_of` dropped and
// added again in their grown spelling, each with `service-provider` — four
// statements diffed from the two tables as 0024 still had them
// (ticket-as-of.ts), since an applied file is never edited;
// resolution-rendering.test.ts maps today's tables back (`CHANGED_LATER`).
// Then migration 0031, which is exactly those statements under its header:
// no table is new, so nothing is hand-written, and every source and
// visibility a row holds is still in its list, so nothing is guarded. No
// database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { TICKET_SOURCES, TICKET_VISIBILITIES } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { agreement } from "../schema/agreements"
import { container } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { driver } from "../schema/fleet"
import { company, project } from "../schema/organisation"
import { ticket, ticketEvent } from "../schema/resolution"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"
import { statementsBetween } from "./specimen"
import { TICKET_SOURCES_AS_OF_0009, TICKET_VISIBILITIES_AS_OF_0009, ticketAsOf, ticketEventAsOf0009 } from "./ticket-as-of"

const MIGRATION = "0031_provider_tickets.sql"

const referenced = { company, project, userAccount, route, pickup, container, property, sharedCollectionPoint, agreement, driver, customer }

describe("a Service Provider's tickets as drizzle-kit writes them", () => {
  const generated = statementsBetween({ ...referenced, ticket: ticketAsOf("0016"), ticketEvent: ticketEventAsOf0009 }, { ...referenced, ticket: ticketAsOf("0031"), ticketEvent })

  test("the ticket's source check and the history's visibility check are replaced in their grown spelling, and nothing else moves", async () => {
    assert.deepEqual(await generated, [
      'ALTER TABLE "wms"."ticket" DROP CONSTRAINT "ticket_source_one_of";',
      'ALTER TABLE "wms"."ticket_event" DROP CONSTRAINT "ticket_event_visibility_one_of";',
      `ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_source_one_of" CHECK (${ref("ticket", "source")} in (${list(...TICKET_SOURCES)}));`,
      `ALTER TABLE "wms"."ticket_event" ADD CONSTRAINT "ticket_event_visibility_one_of" CHECK (${ref("ticket_event", "visibility")} in (${list(...TICKET_VISIBILITIES)}));`,
    ])
  })

  test("migration 0031 is exactly those statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, (await generated).map(normalised))
  })

  test("each list is 0009's and service-provider after it, so every row already written still passes", () => {
    assert.deepEqual([...TICKET_SOURCES], [...TICKET_SOURCES_AS_OF_0009, "service-provider"])
    assert.deepEqual([...TICKET_VISIBILITIES], [...TICKET_VISIBILITIES_AS_OF_0009, "service-provider"])
    assert.equal(checksOf(ticket).get("ticket_source_one_of"), `${ref("ticket", "source")} in (${list(...TICKET_SOURCES)})`)
    assert.equal(checksOf(ticketEvent).get("ticket_event_visibility_one_of"), `${ref("ticket_event", "visibility")} in (${list(...TICKET_VISIBILITIES)})`)
  })
})
