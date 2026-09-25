import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OBJECT_EXTENSIONS, ObjectKey } from "../execution"
import { ALERT_KINDS, ALERT_SEVERITIES, ALERT_SOURCES, ALERT_STATUSES, TICKET_EVENT_KINDS, TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_SOURCES, TICKET_STATUSES, TICKET_VISIBILITIES } from "@waste/domain/resolution/vocabulary"

import {
  AlertKind,
  AlertSeverity,
  AlertSource,
  AlertStatus,
  TICKET_NUMBER_PREFIX,
  TICKET_OBJECT_EXTENSIONS,
  TICKET_OBJECT_KEY,
  TICKET_OBJECT_KEY_SHAPE,
  TicketEventKind,
  TicketKind,
  ticketLabel,
  TicketObjectKey,
  TicketPriority,
  TicketResolution,
  TicketSource,
  TicketStatus,
  TicketVisibility,
} from "../resolution"
import { refusal } from "./expect"

const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000001"
const TICKET = "01a0d3a5-e5e0-7000-8000-000000000002"
const EVENT = "01a0d3a5-e5e0-7000-8000-000000000003"

describe("the Resolution enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(TicketStatus.options, [...TICKET_STATUSES])
    assert.deepEqual(TicketKind.options, [...TICKET_KINDS])
    assert.deepEqual(TicketPriority.options, [...TICKET_PRIORITIES])
    assert.deepEqual(TicketSource.options, [...TICKET_SOURCES])
    assert.deepEqual(TicketResolution.options, [...TICKET_RESOLUTIONS])
    assert.deepEqual(TicketEventKind.options, [...TICKET_EVENT_KINDS])
    assert.deepEqual(TicketVisibility.options, [...TICKET_VISIBILITIES])
    assert.deepEqual(AlertKind.options, [...ALERT_KINDS])
    assert.deepEqual(AlertSeverity.options, [...ALERT_SEVERITIES])
    assert.deepEqual(AlertSource.options, [...ALERT_SOURCES])
    assert.deepEqual(AlertStatus.options, [...ALERT_STATUSES])
  })

  test("refuse the prototype's display strings and the readings that are never stored", () => {
    assert.equal(TicketStatus.safeParse("created").success, false, "Created folds into open")
    assert.equal(TicketStatus.safeParse("Waiting for customer").success, false, "the portal's words for pending")
    assert.equal(TicketSource.safeParse("driver").success, false, "Execution spells it driver-app")
    assert.equal(TicketSource.safeParse("driver-app").success, true)
    assert.equal(TicketEventKind.safeParse("edited").success, false, "the audit log's, not the domain model's")
    assert.equal(TicketEventKind.safeParse("message").success, false, "the glossary's Avoid: a comment")
    assert.equal(AlertStatus.safeParse("linked").success, false, "a reading of ticketId")
    assert.equal(AlertSource.safeParse("IoT sensor").success, false)
    assert.equal(AlertSource.safeParse("telemetry").success, true, "its token is kept for the source to come")
  })
})

describe("the ticket label", () => {
  test("is the number under the one prefix", () => {
    assert.equal(TICKET_NUMBER_PREFIX, "T-")
    assert.equal(ticketLabel(8831), "T-8831")
    assert.equal(ticketLabel(7), "T-7")
  })
})

describe("TicketObjectKey", () => {
  test("is <companyId>/<ticketId>/<eventId>.<ext> over the four image formats and pdf, lowercase UUIDs, and nothing else", () => {
    for (const extension of TICKET_OBJECT_EXTENSIONS) assert.equal(TicketObjectKey.safeParse(`${COMPANY}/${TICKET}/${EVENT}.${extension}`).success, true, extension)
    assert.deepEqual([...TICKET_OBJECT_EXTENSIONS], [...OBJECT_EXTENSIONS, "pdf"], "a proof's formats and one more")
    for (const wrong of [
      `${COMPANY}/${TICKET}/${EVENT}.gif`,
      `${COMPANY}/${TICKET}/${EVENT}.PDF`,
      `${COMPANY}/${TICKET}/${EVENT}`,
      `${COMPANY}/${EVENT}.pdf`,
      `${COMPANY.toUpperCase()}/${TICKET}/${EVENT}.jpg`,
      `../${TICKET}/${EVENT}.jpg`,
      `${COMPANY}/${TICKET}/${EVENT}.pdf/extra`,
      `${COMPANY}/${TICKET}/${EVENT}/${EVENT}.pdf`,
    ]) {
      assert.deepEqual(refusal(TicketObjectKey.safeParse(wrong)), [{ path: "", message: TICKET_OBJECT_KEY_SHAPE }], wrong)
    }
    assert.equal(TICKET_OBJECT_KEY.test(`${COMPANY}/${TICKET}/${EVENT}.png`), true)
  })

  test("is spelled apart from a proof's key: a pdf is a ticket's attachment and never a proof's object", () => {
    const pdf = `${COMPANY}/${TICKET}/${EVENT}.pdf`
    assert.equal(TicketObjectKey.safeParse(pdf).success, true)
    assert.equal(ObjectKey.safeParse(pdf).success, false)
  })
})
