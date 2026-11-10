import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ATTACHMENT_EXTENSIONS, ATTACHMENT_KEY_SHAPE } from "@waste/domain/storage-objects"

import { ObjectKey } from "../execution"

import { AlertSource, AlertStatus, TicketEventKind, TicketObjectKey, TicketSource, TicketStatus } from "../resolution"
import { refusal } from "./expect"

const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000001"
const TICKET = "01a0d3a5-e5e0-7000-8000-000000000002"
const OBJECT = "01a0d3a5-e5e0-7000-8000-000000000003"

describe("the Resolution enums", () => {
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

describe("TicketObjectKey", () => {
  test("is <companyId>/<ticketId>/<objectId>.<ext> over the four image formats and pdf, lowercase UUIDs, and nothing else", () => {
    for (const extension of ATTACHMENT_EXTENSIONS) assert.equal(TicketObjectKey.safeParse(`${COMPANY}/${TICKET}/${OBJECT}.${extension}`).success, true, extension)
    for (const wrong of [
      `${COMPANY}/${TICKET}/${OBJECT}.gif`,
      `${COMPANY}/${TICKET}/${OBJECT}.PDF`,
      `${COMPANY}/${TICKET}/${OBJECT}`,
      `${COMPANY}/${OBJECT}.pdf`,
      `${COMPANY.toUpperCase()}/${TICKET}/${OBJECT}.jpg`,
      `../${TICKET}/${OBJECT}.jpg`,
      `${COMPANY}/${TICKET}/${OBJECT}.pdf/extra`,
      `${COMPANY}/${TICKET}/${OBJECT}/${OBJECT}.pdf`,
    ]) {
      assert.deepEqual(refusal(TicketObjectKey.safeParse(wrong)), [{ path: "", message: ATTACHMENT_KEY_SHAPE }], wrong)
    }
  })

  test("is spelled apart from a proof's key: a pdf is a ticket's attachment and never a proof's object", () => {
    const pdf = `${COMPANY}/${TICKET}/${OBJECT}.pdf`
    assert.equal(TicketObjectKey.safeParse(pdf).success, true)
    assert.equal(ObjectKey.safeParse(pdf).success, false)
    // The path is the one shape (@waste/domain/storage-objects' threeIdsAndFormat); the formats are what tell the two apart.
    const jpg = `${COMPANY}/${TICKET}/${OBJECT}.jpg`
    assert.equal(TicketObjectKey.safeParse(jpg).success, true)
    assert.equal(ObjectKey.safeParse(jpg).success, true)
  })
})
