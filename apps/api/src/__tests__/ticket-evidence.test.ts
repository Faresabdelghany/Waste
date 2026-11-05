// The ticket endpoints (Issue #109): the stop's evidence and the reply with it
// (M6 of #293), and the comments, over the setup ticket-suite.ts shares with
// tickets.test.ts and ticket-commands.test.ts.
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

import { TICKET_OBJECT_KEY_SHAPE } from "@waste/contracts/resolution"
import { TicketType } from "@waste/contracts/ticket-types"
import { Ticket, TicketDetail, TicketEvent, TicketEvidence } from "@waste/contracts/tickets"
import { type Database, type Tx } from "@waste/db/client"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { and, eq, sql } from "drizzle-orm"

import { type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { at, seedRoute, TOWN_HALL, type ExecutionFixtures } from "./execution-fixtures"
import { type FleetFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"
import { database, NOON, owner, ticketCalls, ticketSuite } from "./ticket-suite"

describe("the ticket endpoints", { skip: database.skip || owner.skip }, () => {
  const suite = ticketSuite()
  let pool: Database
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let viewer: Call
  let lars: Call
  let ungranted: Call
  let harbors: Ticket
  let theirs: Ticket

  before(() => {
    ;({ pool, a, fleet, ex, olivia, viewer, lars, ungranted, harbors, theirs } = suite.current)
  })

  const { refused, opened, read, history, eventsAbout, inStatus } = ticketCalls(() => suite.current)

  describe("the stop's evidence (M6 of #293)", () => {
    /** The completed route's three stops: collected at 06:45, failed `not-presented` at 07:12, skipped `route-ended` at 13:00. */
    const stop = (index: number) => ({ routeId: ex.routes.completed.id, pickupId: ex.routes.completed.pickupIds[index] })
    const NOT_PRESENTED = "Our driver was at the address at 07:12 on Monday 5 October and recorded that the bin was not put out for collection."
    const COLLECTED = "Our driver collected the bin at 06:45 on Monday 5 October."
    const evidenceOf = async (id: string, call = olivia): Promise<TicketEvidence> => {
      const response = await call(`/tickets/${id}/evidence`)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      return TicketEvidence.parse(await response.json())
    }
    const reply = (id: string, values: unknown, call = olivia) => call(`/tickets/${id}/reply-with-evidence`, { method: "POST", body: values })

    test("reads what the stop recorded: the outcome, when on the project's clock, where the failure stood, its proofs, the reply, and whether the record answers the case", async () => {
      const missed = await opened({ answerFromRecord: false, links: stop(1) })
      const evidence = await evidenceOf(missed.id)
      assert.ok(evidence.stop !== null)
      const { proofs, ...rest } = evidence.stop
      assert.deepEqual(rest, {
        pickupId: ex.routes.completed.pickupIds[1],
        routeId: ex.routes.completed.id,
        outcome: "failed",
        reason: "not-presented",
        service: "empty",
        corrected: false,
        at: "2026-10-05T05:12:00.000Z",
        location: TOWN_HALL,
        reply: NOT_PRESENTED,
        answeredByRecord: true,
      })
      assert.deepEqual(
        proofs.map((proof) => [proof.kind, proof.source, proof.reason]),
        [
          ["arrival", "driver-app", null],
          ["failure", "driver-app", "not-presented"],
        ],
        "the stop's own proofs, in recording order",
      )
      assert.deepEqual(Object.keys(proofs[0]).sort(), ["id", "kind", "objectKey", "occurredAt", "outcome", "reason", "source"], "narrowed under the ticket's grant: no device, account, session, driver's note or weight")

      const ended = (await evidenceOf((await opened({ answerFromRecord: false, links: stop(2) })).id)).stop
      assert.equal(ended?.reply, "The bin was not collected: the route ended at 13:00 on Monday 5 October before our driver reached it.", "never puts the driver at an address the route never reached")

      const collected = (await evidenceOf((await opened({ links: stop(0) })).id)).stop
      assert.deepEqual([collected?.outcome, collected?.reply, collected?.answeredByRecord], ["completed", COLLECTED, false], "a collected stop answers nothing by itself")
      const overflow = (await evidenceOf((await opened({ kind: "overflow", links: stop(1) })).id)).stop
      assert.equal(overflow?.answeredByRecord, false, "only a missed collection is answered by the bin not being out")
      assert.deepEqual(await evidenceOf((await opened()).id), { stop: null }, "a ticket about no stop has no evidence")

      await refused(await olivia(`/tickets/${theirs.id}/evidence`), 404)
      await refused(await viewer(`/tickets/${harbors.id}/evidence`), 404)
      assert.match((await refused(await ungranted(`/tickets/${missed.id}/evidence`), 403)).detail ?? "", /view on operate\.tickets/)
    })

    test("answers a missed collection the record answers as it opens: the reply on the customer's thread, the case completed `answered`, ticket-completed after ticket-opened", async () => {
      const answered = await opened({ links: stop(1) })
      assert.deepEqual([answered.status, answered.resolution, answered.closedAt], ["completed", "answered", NOON.toISOString()], "the 201 answers it completed")
      const detail = await read(answered.id)
      assert.deepEqual(
        detail.events.map((event) => [event.kind, event.status, event.visibility, event.resolution, event.body]),
        [
          ["created", "open", "internal", null, null],
          ["comment", "open", "customer", null, NOT_PRESENTED],
          ["status-changed", "completed", "internal", "answered", "Answered with the stop's record."],
        ],
      )
      assert.deepEqual((await eventsAbout(answered.id)).map((event) => event.kind), ["ticket-opened", "ticket-replied", "ticket-completed"], "the reply is the customer's news (C18 of #291)")
      assert.deepEqual(Ticket.parse((await eventsAbout(answered.id))[2].payload), answered, "the completion carries the ticket as answered")

      for (const [values, why] of [
        [{ links: stop(0) }, "a collected stop"],
        [{ links: stop(2) }, "a stop skipped for another reason"],
        [{ kind: "overflow", links: stop(1) }, "another kind of case"],
        [{ answerFromRecord: false, links: stop(1) }, "the office asked to judge it"],
      ] as const) {
        const left = await opened(values)
        assert.equal(left.status, "open", `${why} opens the case`)
        assert.deepEqual((await read(left.id)).events.map((event) => event.kind), ["created"], `${why}: no reply is written`)
      }

      // The office corrected a collected stop to not-presented: its word, not the driver's record, so the office judges the case.
      const corrected = await seedRoute(pool, a, fleet, ex, {
        status: "completed",
        pickups: [{ containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, status: "failed", reason: "not-presented", arrivedAt: at(ex.day, "06:40"), outcomeAt: at(ex.day, "11:00") }],
        proofs: [
          { kind: "completion", pickupIndex: 0, occurredAt: at(ex.day, "06:45"), location: TOWN_HALL },
          { kind: "correction", pickupIndex: 0, occurredAt: at(ex.day, "11:00"), source: "dispatch", outcome: "failed", reason: "not-presented", note: "The resident sent a photo of an empty kerb" },
        ],
      })
      const judged = await opened({ links: { routeId: corrected.id, pickupId: corrected.pickupIds[0] } })
      assert.equal(judged.status, "open", "an outcome the office corrected answers no case by itself")
      const review = (await (await olivia(`/tickets/${judged.id}/evidence`)).json()) as TicketEvidence
      assert.deepEqual([review.stop?.corrected, review.stop?.answeredByRecord, review.stop?.reply], [true, false, "Our office reviewed the collection at 11:00 on Monday 5 October and recorded that the bin was not put out for collection."])
    })

    test("the record answers a missed collection whatever its type asks of a person: the type's roles and fields bind the office's completion, not the system's answer (#545 of #544)", async () => {
      const made = await olivia("/ticket-types", { method: "POST", body: { name: "Missed collection, claimed", kind: "missed-collection" } })
      assert.equal(made.status, 201, JSON.stringify(await made.clone().json()))
      const type = TicketType.parse(await made.json())
      await olivia(`/ticket-types/${type.id}/fields`, { method: "PUT", body: { fields: [{ key: "claim", label: "Claim", input: "choice", choices: ["Upheld", "Dismissed"], requirement: "to-complete" }] } })
      await olivia(`/ticket-types/${type.id}/permissions`, { method: "PUT", body: { permissions: [{ command: "complete", roleIds: [a.roles.viewer.id] }] } })
      const answered = await opened({ ticketTypeId: type.id, links: stop(1) })
      assert.deepEqual([answered.ticketTypeId, answered.status, answered.resolution], [type.id, "completed", "answered"], "neither the role nor the empty claim holds back the record's answer")
      const judged = await opened({ ticketTypeId: type.id, answerFromRecord: false, links: stop(1) })
      const byHand = await refused(await olivia(`/tickets/${judged.id}/complete`, { method: "POST", body: { resolution: "answered", note: "Answered by phone" } }), 403)
      assert.equal(byHand.detail, "Only Viewer may complete a ticket of type Missed collection, claimed", "the office's own completion is held to the type")
    })

    test("replies with the record and the office's note in one step, completing the case only when asked, and answers 201 with the history and no Location", async () => {
      const fresh = await opened({ links: stop(0) })
      await nextMillisecond()
      const response = await reply(fresh.id, { note: "The bin was emptied on time." })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      assert.equal(response.headers.get("location"), null, "a reply is a history row, with no address of its own")
      const detail = TicketDetail.parse(await response.json())
      assert.equal(detail.status, "open", "the reply alone moves nothing")
      assert.deepEqual([detail.events.at(-1)?.kind, detail.events.at(-1)?.visibility, detail.events.at(-1)?.body], ["comment", "customer", `${COLLECTED}\n\nThe bin was emptied on time.`])
      assert.equal(detail.updatedAt, fresh.updatedAt, "nothing of the row moves")
      const replied = await eventsAbout(fresh.id)
      assert.deepEqual(replied.map((event) => event.kind), ["ticket-opened", "ticket-replied"], "a reply is the customer's news, the notices' (C18 of #291)")
      assert.deepEqual(TicketEvent.parse(replied[1].payload), detail.events.at(-1), "carrying the history row as the route answers it")

      const done = TicketDetail.parse(await (await reply(fresh.id, { complete: true })).json())
      assert.deepEqual([done.status, done.resolution, done.closedAt], ["completed", "answered", NOON.toISOString()])
      assert.deepEqual(done.events.slice(-2).map((event) => [event.kind, event.status, event.body]), [["comment", "open", COLLECTED], ["status-changed", "completed", "Answered with the stop's record."]], "the reply is written before the completion, stamped with the status it met")
      assert.deepEqual((await eventsAbout(fresh.id)).map((event) => event.kind), ["ticket-opened", "ticket-replied", "ticket-replied", "ticket-completed"])

      const before = (await history(fresh.id)).length
      assert.equal((await refused(await reply(fresh.id, { complete: true }), 409)).detail, `Ticket ${fresh.label} is completed; reopen it first`)
      assert.equal((await history(fresh.id)).length, before, "a refused completion leaves no reply behind")
      assert.equal((await reply(fresh.id, {})).status, 201, "the reply alone is taken on a closed ticket, as a comment is")
    })

    test("refuses a ticket about no stop, a member the body does not take, and answers 404 and 403 like every route here", async () => {
      const nowhere = await opened()
      assert.equal((await refused(await reply(nowhere.id, {}), 409)).detail, "This ticket names no stop, so no record answers it")
      const fresh = await opened({ links: stop(0) })
      assert.deepEqual((await refused(await reply(fresh.id, { complete: true, body: "x" }), 400)).errors?.map((error) => error.path), ["body"], "the reply's words are the record's")
      assert.equal((await history(fresh.id)).length, 1, "no refused reply was appended")
      await refused(await reply(theirs.id, {}), 404)
      await refused(await reply(harbors.id, {}, viewer), 404)
      assert.match((await refused(await reply(fresh.id, {}, ungranted), 403)).detail ?? "", /edit on operate\.tickets/)
      assert.match((await refused(await reply(fresh.id, {}, lars), 403)).detail ?? "", /edit on operate\.tickets/, "the provider's manager may comment, not answer the case")
    })
  })

  describe("POST /tickets/:id/comments", () => {
    const comment = (id: string, values: unknown, call = olivia) => call(`/tickets/${id}/comments`, { method: "POST", body: values })

    test("appends a comment, internal unless said, on an open or a closed ticket, touching the row not at all, and answers 201 without Location", async () => {
      const done = await inStatus("completed")
      await nextMillisecond()
      const response = await comment(done.id, { body: "The customer thanked us" })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      assert.equal(response.headers.get("location"), null, "a history row has no address of its own")
      const row = TicketEvent.parse(await response.json())
      assert.deepEqual([row.ticketId, row.kind, row.status, row.assigneeUserAccountId, row.body, row.visibility, row.objectKey, row.resolution, row.recordedBy, row.sourceEventId], [done.id, "comment", "completed", null, "The customer thanked us", "internal", null, null, a.users.olivia.id, null], "the snapshot is the closed ticket's")
      const after = await read(done.id)
      assert.equal(after.updatedAt, done.updatedAt, "nothing of the row moves")
      assert.deepEqual([after.status, after.closedAt], ["completed", done.closedAt])
      assert.equal(after.events.at(-1)?.id, row.id)
      const customers = TicketEvent.parse(await (await comment(done.id, { body: "We are sorry", visibility: "customer" })).json())
      assert.equal(customers.visibility, "customer")
      assert.deepEqual((await eventsAbout(done.id)).map((event) => event.kind).slice(2), ["ticket-replied"], "an internal comment is nobody else's news; the customer's is theirs")
      const viewers = await comment((await opened()).id, { body: "From Vera" }, viewer)
      assert.equal(viewers.status, 201, "create is the grant, as it is for opening a ticket")
    })

    test("holds the attachment key to its shape and to the row's own company and ticket, stores a matching one, and answers 404 and 403 like every route here", async () => {
      const fresh = await opened()
      const shape = await refused(await comment(fresh.id, { body: "See attached", objectKey: "photos/bin.jpg" }), 400)
      assert.deepEqual(shape.errors, [{ path: "objectKey", message: TICKET_OBJECT_KEY_SHAPE }])
      const anotherTicket = await refused(await comment(fresh.id, { body: "See attached", objectKey: `${a.companyId}/${harbors.id}/${testId()}.pdf` }), 400)
      assert.deepEqual(anotherTicket.errors, [{ path: "objectKey", message: "The attachment key names another company or another ticket" }])
      const anotherCompany = await refused(await comment(fresh.id, { body: "See attached", objectKey: `${testId()}/${fresh.id}/${testId()}.jpg` }), 400)
      assert.deepEqual(anotherCompany.errors, [{ path: "objectKey", message: "The attachment key names another company or another ticket" }])
      assert.deepEqual((await refused(await comment(fresh.id, {}), 400)).errors?.map((error) => error.path), ["body"])
      assert.deepEqual((await refused(await comment(fresh.id, { body: "x", kind: "created" }), 400)).errors?.map((error) => error.path), ["kind"], "the kind is the server's")
      assert.equal((await history(fresh.id)).length, 1, "no refused comment was appended")
      // The object's id is the client's, minted before the upload (#109 §7.23 as corrected at integration): a key under this company and ticket is stored as sent.
      const objectKey = `${a.companyId}/${fresh.id}/${testId()}.pdf`
      const attached = await comment(fresh.id, { body: "See attached", objectKey })
      assert.equal(attached.status, 201, JSON.stringify(await attached.clone().json()))
      assert.equal(TicketEvent.parse(await attached.json()).objectKey, objectKey)
      assert.equal((await history(fresh.id)).at(-1)?.objectKey, objectKey, "the key is what the history reads back")
      await refused(await comment(theirs.id, { body: "Mine" }), 404)
      await refused(await comment(harbors.id, { body: "Mine" }, viewer), 404)
      assert.match((await refused(await comment(harbors.id, { body: "Mine" }, ungranted), 403)).detail ?? "", /create on operate\.tickets/)
    })

    test("reads its snapshot under the ticket's row lock: a comment sent while a start is in flight waits for it and carries the status the start wrote, never one the row has left", async () => {
      // The start is hand-driven — the row moved to in-progress the way `start` writes it, its event appended, the transaction held open — so a read without the lock would pass it (READ COMMITTED: an uncommitted row is invisible), see `open`, and append a comment stamped `open` after the start committed, a history of `[status-changed in-progress, comment open]`. With the lock the comment waits: the start commits only once Postgres reports the comment blocked behind it (`pg_blocking_pids`, the driver suite's precedent), and the comment then reads the row the start left.
      const fresh = await opened()
      const released = Promise.withResolvers<void>()
      const started = Promise.withResolvers<number>()
      const start = withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        await tx
          .update(ticket)
          .set({ status: "in-progress" })
          .where(and(eq(ticket.companyId, a.companyId), eq(ticket.id, fresh.id)))
        await tx.insert(ticketEvent).values({ id: testId(), companyId: a.companyId, projectId: fresh.projectId, ticketId: fresh.id, kind: "status-changed", status: "in-progress", recordedBy: a.users.olivia.id })
        started.resolve(pid)
        await released.promise
      })
      /** Rejects if the start ends before it is released — a write refused, say — so a broken start fails the test instead of hanging it on the pid. */
      const endedEarly = start.then(() => Promise.reject(new Error("the start's transaction ended before it was released")))
      void endedEarly.catch(() => undefined)
      const commenting = comment(fresh.id, { body: "Called the customer back" })
      try {
        const pid = await Promise.race([started.promise, endedEarly])
        const blocked = async (): Promise<boolean> => (await pool.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await blocked())) {
          assert.ok(Date.now() < deadline, "the comment never waited on the start: its read took no lock")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        released.resolve()
        await start
        await commenting.catch(() => undefined)
      }
      const response = await commenting
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      const row = TicketEvent.parse(await response.json())
      assert.equal(row.status, "in-progress", "the snapshot is the row as the start left it")
      assert.deepEqual(
        (await history(fresh.id)).map((event) => [event.kind, event.status]),
        [
          ["created", "open"],
          ["status-changed", "in-progress"],
          ["comment", "in-progress"],
        ],
        "the history reads in the order the row moved",
      )
      assert.equal((await read(fresh.id)).status, "in-progress", "the start moved the row; the comment did not")
    })
  })
})
