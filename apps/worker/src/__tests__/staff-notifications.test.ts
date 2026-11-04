// The staff notices (O16 of #290), on the shared local database with a tenant
// of this file's own: an alert raised e-mails every active account that asked
// for alerts that severe and reads it on the board in its project, and nobody
// else; a ticket assigned e-mails its assignee where they asked; a redelivery
// writes nothing; and the send takes a staff notice without asking anyone's
// consent.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import type { Database } from "@waste/db/client"
import { createDb } from "@waste/db/client"
import { SEND_MESSAGE_QUEUE } from "@waste/db/commands/messaging"
import { alertColumns, alertOf, ticketColumns, ticketOf } from "@waste/db/commands/resolution-rows"
import type { Send } from "@waste/db/jobs"
import { projectAccess, role, roleGrant, userAccount } from "@waste/db/schema/access"
import { message } from "@waste/db/schema/messaging"
import { notificationPreference } from "@waste/db/schema/notifications"
import { alert, ticket } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import type { AlertSeverity } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, isNotNull } from "drizzle-orm"

import type { JobContext } from "../jobs/definition"
import { sendMessage } from "../jobs/send-message"
import { ALERTS_MODULE, notifyStaffFor } from "../jobs/staff-notifications"
import type { MessagingProvider, OutgoingMessage } from "../messaging/provider"
import { at, dropConsumerTenant, outboxJob, seedConsumerTenant, testId, type ConsumerTenant } from "./consumer-fixtures"
import { databaseUnderTest, ownerUnderTest } from "./database"

const api = databaseUnderTest()
const owner = ownerUnderTest()

describe("the staff notices", { skip: api.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let tenant: ConsumerTenant
  const lines: string[] = []
  const sent: Array<{ name: string; data: unknown }> = []
  const send: Send = async (name, data) => {
    sent.push({ name, data })
    return testId()
  }
  const context = () => ({ api: pool, send, now: () => at("13:30"), log: (line: string) => void lines.push(line) }) as unknown as JobContext
  /** Who is who: the board's role reads alerts, the clerk's reads nothing of them. */
  const people = {
    ida: { id: testId(), name: "Ida Berg" },
    jonas: { id: testId(), name: "Jonas Lund" },
    karin: { id: testId(), name: "Karin Dahl" },
    ole: { id: testId(), name: "Ole Krogh" },
    pia: { id: testId(), name: "Pia Nørgaard" },
  }

  before(async () => {
    pool = createDb(api.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    tenant = await seedConsumerTenant(pool)
    const board = testId()
    const clerk = testId()
    const { companyId } = tenant
    const account = (who: { id: string; name: string }, roleId: string, extra: { allProjects?: boolean; deactivatedAt?: Date } = {}) => ({
      id: who.id,
      companyId,
      authUserId: randomUUID(),
      email: `${who.name.split(" ")[0].toLowerCase()}@${companyId.slice(-8)}.example`,
      fullName: who.name,
      roleId,
      ...extra,
    })
    const wants = (userAccountId: string, minSeverity: AlertSeverity) => ({ companyId, userAccountId, event: "alert-raised", minSeverity })
    await withCompany(pool.db, companyId, async (tx) => {
      await tx.insert(role).values([
        { id: board, companyId, key: null, name: "Board", scope: "Company", description: "Watches the alerts", system: false },
        { id: clerk, companyId, key: null, name: "Clerk", scope: "Company", description: "Reads no alert", system: false },
      ])
      await tx.insert(roleGrant).values([
        { companyId, roleId: board, moduleKey: ALERTS_MODULE, action: "view" },
        { companyId, roleId: clerk, moduleKey: "customers.contacts", action: "view" },
      ])
      await tx.insert(userAccount).values([
        // Ida: every project, alerts from high.
        account(people.ida, board, { allProjects: true }),
        // Jonas: this project by Project Access, critical alerts alone.
        account(people.jonas, board),
        // Karin: no project of hers here, every alert.
        account(people.karin, board),
        // Ole: every project but no grant on the board, every alert.
        account(people.ole, clerk, { allProjects: true }),
        // Pia: deactivated, every alert.
        account(people.pia, board, { allProjects: true, deactivatedAt: new Date() }),
      ])
      await tx.insert(projectAccess).values({ companyId, userAccountId: people.jonas.id, projectId: tenant.projectId })
      await tx.insert(notificationPreference).values([
        wants(people.ida.id, "high"),
        wants(people.jonas.id, "critical"),
        wants(people.karin.id, "low"),
        wants(people.ole.id, "low"),
        wants(people.pia.id, "low"),
        { companyId, userAccountId: tenant.officeUserId, event: "ticket-assigned", minSeverity: null },
      ])
    })
  })
  after(async () => {
    if (tenant !== undefined) await dropConsumerTenant(pool, ownerPool, tenant.companyId)
    await pool?.close()
    await ownerPool?.close()
  })

  const raised = async (severity: AlertSeverity) => {
    const [row] = await withCompany(pool.db, tenant.companyId, (tx) =>
      tx
        .insert(alert)
        .values({ companyId: tenant.companyId, projectId: tenant.projectId, kind: "resource", severity, source: "manual", status: "new", title: "Hydraulics leaking", details: "WH-24 left a trail on Parkvej.", detectedAt: at("07:00"), vehicleId: tenant.vehicleId, raisedBy: tenant.officeUserId })
        .returning(alertColumns),
    )
    return alertOf(row)
  }
  let ticketNumber = 40
  const assigned = async (assigneeUserAccountId: string) => {
    ticketNumber += 1
    const [row] = await withCompany(pool.db, tenant.companyId, (tx) =>
      tx
        .insert(ticket)
        .values({ companyId: tenant.companyId, projectId: tenant.projectId, number: ticketNumber, kind: "other", source: "office", priority: "high", subject: "Lid broken at Parkvej 18", description: "The lid hangs by one hinge.", occurredAt: at("08:00"), createdBy: tenant.officeUserId, assigneeUserAccountId })
        .returning(ticketColumns),
    )
    return ticketOf(row)
  }
  const noticesFor = (sourceEventId: string) =>
    withCompany(pool.db, tenant.companyId, (tx) =>
      tx
        .select({ userAccountId: message.userAccountId, recipient: message.recipient, purpose: message.purpose, channel: message.channel, subject: message.subject, body: message.body, status: message.status, customerId: message.customerId })
        .from(message)
        .where(and(eq(message.sourceEventId, sourceEventId), isNotNull(message.userAccountId)))
        .orderBy(asc(message.userAccountId)),
    )

  test("a critical alert reaches those who asked for critical or less severe and read the board in its project, and nobody else", async () => {
    const payload = await raised("critical")
    const event = outboxJob(tenant, { kind: "alert-raised", aggregateKind: "alert", aggregateId: payload.id, payload })
    const before = sent.length
    const outcome = await notifyStaffFor({ ...event, kind: "alert-raised" }, context())
    assert.equal(outcome.queued, 2)
    const notices = await noticesFor(event.id)
    assert.deepEqual(notices.map((notice) => notice.userAccountId).sort(), [people.ida.id, people.jonas.id].sort(), "not Karin (not her project), Ole (no grant) or Pia (deactivated)")
    for (const notice of notices) {
      assert.deepEqual([notice.purpose, notice.channel, notice.status, notice.customerId, notice.subject], ["staff", "email", "queued", null, "Critical alert · Hydraulics leaking"])
      assert.match(notice.body, /^A critical alert was raised in Copenhagen Central\.\n\nHydraulics leaking\nWH-24 left a trail on Parkvej\./)
    }
    assert.deepEqual(sent.slice(before).map((job) => job.name), [SEND_MESSAGE_QUEUE, SEND_MESSAGE_QUEUE], "each notice's send job beside it")

    const again = await notifyStaffFor({ ...event, kind: "alert-raised" }, context())
    assert.equal(again.queued, 0, "a redelivery writes nothing")
    assert.equal((await noticesFor(event.id)).length, 2)
    assert.equal(sent.length, before + 2, "and sends nothing")
  })

  test("a high alert reaches Ida alone, and a medium one nobody", async () => {
    const high = await raised("high")
    const highEvent = outboxJob(tenant, { kind: "alert-raised", aggregateKind: "alert", aggregateId: high.id, payload: high })
    await notifyStaffFor({ ...highEvent, kind: "alert-raised" }, context())
    assert.deepEqual((await noticesFor(highEvent.id)).map((notice) => notice.userAccountId), [people.ida.id])
    const medium = await raised("medium")
    const mediumEvent = outboxJob(tenant, { kind: "alert-raised", aggregateKind: "alert", aggregateId: medium.id, payload: medium })
    assert.equal((await notifyStaffFor({ ...mediumEvent, kind: "alert-raised" }, context())).queued, 0)
  })

  test("a ticket assigned reaches its assignee where they asked, and nobody where they did not", async () => {
    const lars = await assigned(tenant.officeUserId)
    const event = outboxJob(tenant, { kind: "ticket-assigned", aggregateKind: "ticket", aggregateId: lars.id, payload: lars })
    await notifyStaffFor({ ...event, kind: "ticket-assigned" }, context())
    const [notice, ...more] = await noticesFor(event.id)
    assert.equal(more.length, 0)
    assert.equal(notice.userAccountId, tenant.officeUserId)
    assert.equal(notice.subject, `Ticket ${lars.label} assigned to you · Lid broken at Parkvej 18`)
    assert.match(notice.body, new RegExp(`^Lars Mikkelsen, ticket ${lars.label} in Copenhagen Central is now yours\\.\\n\\nLid broken at Parkvej 18\\nPriority: high\\.`))

    const idas = await assigned(people.ida.id)
    const unasked = outboxJob(tenant, { kind: "ticket-assigned", aggregateKind: "ticket", aggregateId: idas.id, payload: idas })
    assert.equal((await notifyStaffFor({ ...unasked, kind: "ticket-assigned" }, context())).queued, 0, "Ida asked for alerts, not assignments")
  })

  test("the send takes a staff notice to its address without asking anyone's consent", async () => {
    const payload = await raised("critical")
    const event = outboxJob(tenant, { kind: "alert-raised", aggregateKind: "alert", aggregateId: payload.id, payload })
    await notifyStaffFor({ ...event, kind: "alert-raised" }, context())
    const [row] = await withCompany(pool.db, tenant.companyId, (tx) => tx.select({ id: message.id, recipient: message.recipient }).from(message).where(and(eq(message.sourceEventId, event.id), eq(message.userAccountId, people.ida.id))))
    const handed: OutgoingMessage[] = []
    const provider: MessagingProvider = { name: "scripted", send: async (outgoing) => (handed.push(outgoing), { providerMessageId: "x" }) }
    assert.equal(await sendMessage({ companyId: tenant.companyId, messageId: row.id }, { ...context(), messaging: provider }), "sent")
    assert.deepEqual(handed.map((outgoing) => outgoing.to), [row.recipient])
  })
})
