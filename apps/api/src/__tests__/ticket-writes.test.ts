// The ticket-opening statements, in order, without a database (Issue #109
// §6): a scripted `tx` records every statement `openTicket` runs and answers
// what each would — the counter's next number, the row as inserted, the
// alert as it stands — so the suite can say that the counter comes before the
// row, the row before the `created` event, the alert's link (under its lock)
// after the event, the outbox event, then the type's opening actions read
// (#546 of #544) and the row read back as they leave it; the `sets.test.ts`
// precedent.
// The statements themselves run against Postgres in tickets.test.ts.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Tx } from "@waste/db/client"
import { getTableName, type Table } from "drizzle-orm"

import { createIdMinter } from "@waste/db/ids"
import { appendTicketEvent, openTicket, type TicketDraft } from "@waste/db/commands/open-ticket"
import { Refused } from "@waste/domain/refusal"

const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000000"
const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const OLIVIA = "01a0d3a5-e5e0-7000-8000-000000000002"
const ALERT = "01a0d3a5-e5e0-7000-8000-000000000003"
const ROUTE = "01a0d3a5-e5e0-7000-8000-000000000004"
const TYPE = "01a0d3a5-e5e0-7000-8000-000000000005"
const STAMP = new Date("2026-10-05T12:00:00Z")
const OPENED = new Date("2026-10-05T12:00:01Z")

type Statement = { kind: "update" | "insert" | "select"; table: string; values?: Record<string, unknown>; locked?: string }

const scripted = (alertRow?: { status: string; ticketId: string | null }) => {
  const statements: Statement[] = []
  let inserted: Record<string, unknown> | undefined
  const tx = {
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const name = getTableName(table)
          statements.push({ kind: "update", table: name, values })
          const rows = name === "company" ? [{ next: 8832 }] : name === "alert" && alertRow !== undefined ? [{ id: ALERT, ...alertRow, ...values }] : []
          return Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) })
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        const name = getTableName(table)
        statements.push({ kind: "insert", table: name, values })
        const row = name === "ticket" ? { ...values, createdAt: STAMP, updatedAt: STAMP } : name === "ticket_event" ? { ...values, recordedAt: STAMP } : values
        if (name === "ticket") inserted = row
        return Object.assign(Promise.resolve(undefined), { returning: () => Promise.resolve([row]) })
      },
    }),
    select: () => ({
      from: (table: Table) => {
        const query = {
          // The project's default team is read through its team, so a retired one is passed over (O30 of #290).
          innerJoin: () => query,
          where: () => {
            const name = getTableName(table)
            const statement: Statement = { kind: "select", table: name }
            statements.push(statement)
            // The kind's default type is the company's already (#545 of #544), so none is made.
            const rows = name === "alert" && alertRow !== undefined ? [{ id: ALERT, ...alertRow }] : name === "ticket" ? [inserted ?? { number: 8831 }] : name === "ticket_type" ? [{ id: TYPE }] : []
            const limited = Object.assign(Promise.resolve(rows), {
              for: (strength: string) => {
                statement.locked = strength
                return Promise.resolve(rows)
              },
            })
            return Object.assign(Promise.resolve(rows), { limit: () => limited, orderBy: () => Promise.resolve(rows) })
          },
        }
        return query
      },
    }),
  } as unknown as Tx
  return { tx, statements }
}

const draft = (alertId: string | null = null): TicketDraft => ({
  projectId: PROJECT,
  kind: "complaint",
  priority: "high",
  source: "phone",
  subject: "Bin not emptied",
  description: "The bin at Parkvej 18 was not emptied on Monday.",
  occurredAt: STAMP,
  dueAt: null,
  assigneeUserAccountId: OLIVIA,
  links: { routeId: ROUTE, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null },
  alertId,
})

/** Ids that count up from a pinned clock, so the suite can name them. */
const minter = () => createIdMinter(() => STAMP.getTime())

const shape = (statements: readonly Statement[]) => statements.map((statement) => `${statement.kind} ${statement.table}${statement.locked === undefined ? "" : ` for ${statement.locked}`}`)

describe("openTicket", () => {
  test("takes the number from the counter, writes the row, appends the created event and emits ticket-opened, in that order, and names no alert it was not given", async () => {
    const { tx, statements } = scripted()
    const newId = minter()
    const { row, answered } = await openTicket(tx, { companyId: COMPANY, draft: draft(), createdBy: OLIVIA, sourceEventId: null, newId, now: () => OPENED, automation: { send: async () => null, by: null } })
    assert.deepEqual(shape(statements), ["select ticket_type", "select ticket_team_default", "update company", "insert ticket", "insert ticket_event", "insert outbox_event", "insert outbox_event", "select ticket", "select ticket_type_action", "select ticket"])

    const [, , counter, ticketRow, created, outbox, assigned] = statements
    assert.deepEqual([ticketRow.values?.ticketTypeId, ticketRow.values?.fieldValues], [TYPE, {}], "a draft naming no type is of its kind's default, with no values (#545 of #544)")
    assert.ok(counter.values?.nextTicketNumber !== undefined && typeof counter.values.nextTicketNumber !== "number", "the counter steps in the database, as an expression over its own column, never a number read and written back")
    assert.deepEqual([row.number, answered.number, answered.label], [8831, 8831, "T-8831"], "the number taken is the one the counter had, not the one it has now")
    assert.equal(ticketRow.values?.companyId, COMPANY)
    assert.deepEqual(
      [ticketRow.values?.status, ticketRow.values?.createdBy, ticketRow.values?.sourceEventId, ticketRow.values?.routeId, ticketRow.values?.pickupId, ticketRow.values?.resolution, ticketRow.values?.recollectionRouteId, ticketRow.values?.closedAt],
      ["open", OLIVIA, null, ROUTE, null, null, null, null],
      "a person's ticket, open, with its links spelled and its closing columns empty",
    )
    assert.equal(ticketRow.values?.id, row.id)

    assert.equal(created.values?.ticketId, row.id, "the event names the row just written")
    assert.deepEqual(
      [created.values?.kind, created.values?.status, created.values?.assigneeUserAccountId, created.values?.body, created.values?.visibility, created.values?.resolution, created.values?.objectKey, created.values?.recordedBy, created.values?.sourceEventId],
      ["created", "open", OLIVIA, null, "internal", null, null, OLIVIA, null],
      "the created row is the snapshot the ticket started with, recorded by the person who opened it",
    )
    assert.ok(String(created.values?.id) > String(row.id), "the event's id is minted after the ticket's")

    assert.deepEqual([outbox.values?.companyId, outbox.values?.projectId, outbox.values?.kind, outbox.values?.aggregateKind, outbox.values?.aggregateId, outbox.values?.occurredAt], [COMPANY, PROJECT, "ticket-opened", "ticket", row.id, OPENED])
    assert.deepEqual(outbox.values?.payload, answered, "the payload is the ticket as answered")
    assert.deepEqual([assigned.values?.kind, assigned.values?.payload], ["ticket-assigned", answered], "the draft's assignee hears of it as it opened, before its type's actions")
    assert.deepEqual([answered.status, answered.createdBy, answered.sourceEventId, answered.links.routeId, answered.occurredAt, answered.closedAt], ["open", OLIVIA, null, ROUTE, STAMP.toISOString(), null])
  })

  test("links the alert after the event and before the outbox, under the alert's lock, and a consumer's ticket carries the event's id and no person", async () => {
    const { tx, statements } = scripted({ status: "new", ticketId: null })
    const SOURCE = "01a0d3a5-e5e0-7000-8000-000000000009"
    const { row } = await openTicket(tx, { companyId: COMPANY, draft: draft(ALERT), createdBy: null, sourceEventId: SOURCE, newId: minter(), now: () => OPENED, automation: { send: async () => null, by: null } })
    assert.deepEqual(shape(statements), ["select ticket_type", "select ticket_team_default", "update company", "insert ticket", "insert ticket_event", "select alert for no key update", "select alert", "update alert", "insert outbox_event", "insert outbox_event", "select ticket", "select ticket_type_action", "select ticket"])
    const linked = statements[7]
    assert.deepEqual(linked.values, { ticketId: row.id }, "the alert now names the ticket")
    assert.deepEqual([statements[3].values?.createdBy, statements[3].values?.sourceEventId], [null, SOURCE], "an event's ticket: no person, the event's id")
    assert.deepEqual([statements[4].values?.recordedBy, statements[4].values?.sourceEventId], [null, null], "its created row is nobody's, and carries no source event — that key is a folded comment's")
  })

  test("is refused by a resolved alert, and by one linked to another ticket, before the outbox is written", async () => {
    const resolved = scripted({ status: "resolved", ticketId: null })
    await assert.rejects(openTicket(resolved.tx, { companyId: COMPANY, draft: draft(ALERT), createdBy: OLIVIA, sourceEventId: null, newId: minter(), now: () => OPENED, automation: { send: async () => null, by: null } }), (error: unknown) => {
      assert.deepEqual([error instanceof Refused, (error as Refused).refusal?.reason], [true, "conflict"])
      assert.match((error as { message: string }).message, /This alert is resolved and does not change/)
      return true
    })
    assert.deepEqual(shape(resolved.statements), ["select ticket_type", "select ticket_team_default", "update company", "insert ticket", "insert ticket_event", "select alert for no key update", "select alert"], "nothing after the refusal: the transaction is the caller's to roll back")

    const taken = scripted({ status: "acknowledged", ticketId: "01a0d3a5-e5e0-7000-8000-00000000000a" })
    await assert.rejects(openTicket(taken.tx, { companyId: COMPANY, draft: draft(ALERT), createdBy: OLIVIA, sourceEventId: null, newId: minter(), now: () => OPENED, automation: { send: async () => null, by: null } }), (error: unknown) => {
      assert.deepEqual([error instanceof Refused, (error as Refused).refusal?.reason], [true, "conflict"])
      assert.match((error as { message: string }).message, /This alert is linked to ticket T-8831; an alert links to one ticket/)
      return true
    })
    assert.deepEqual(shape(taken.statements).slice(-2), ["select alert", "select ticket"], "the other ticket is read for its label, and no write follows")
  })
})

describe("appendTicketEvent", () => {
  const ref = { companyId: COMPANY, projectId: PROJECT, id: "01a0d3a5-e5e0-7000-8000-00000000000b" }

  test("writes the row under the ticket's three ids with an id the minter gives it, so two rows appended in turn read in that order", async () => {
    const { tx, statements } = scripted()
    const mint = minter()
    const first = await appendTicketEvent(tx, ref, { kind: "comment", status: "open", assigneeUserAccountId: null, resolution: null, body: "A note", visibility: "customer", objectKey: null, recordedBy: OLIVIA, sourceEventId: null }, mint)
    const second = await appendTicketEvent(tx, ref, { kind: "status-changed", status: "in-progress", assigneeUserAccountId: null, resolution: null, body: null, visibility: "internal", objectKey: null, recordedBy: OLIVIA, sourceEventId: null }, mint)
    assert.ok(first.id < second.id, "the minter's ids count up, so the history's order is the id order")
    assert.deepEqual(shape(statements), ["insert ticket_event", "insert ticket_event"])
    assert.deepEqual([statements[0].values?.ticketId, statements[0].values?.companyId, statements[0].values?.projectId], [ref.id, COMPANY, PROJECT])
    assert.deepEqual([statements[0].values?.id, statements[1].values?.id], [first.id, second.id], "the ids written are the minter's")
  })

  test("throws before the insert on a row that disagrees with its kind: the API composes every row, so that is a bug and not a client's", async () => {
    const { tx, statements } = scripted()
    await assert.rejects(
      appendTicketEvent(tx, ref, { kind: "created", status: "open", assigneeUserAccountId: null, resolution: null, body: "not on a created row", visibility: "internal", objectKey: null, recordedBy: OLIVIA, sourceEventId: null }, minter()),
      /A created event carries no body/,
    )
    await assert.rejects(
      appendTicketEvent(tx, ref, { kind: "status-changed", status: "completed", assigneeUserAccountId: null, resolution: null, body: null, visibility: "internal", objectKey: null, recordedBy: OLIVIA, sourceEventId: null }, minter()),
      /carries a resolution exactly when its status is completed/,
    )
    assert.equal(statements.length, 0, "nothing reached the database")
  })
})
