// How a surface waits on a write's outcome (business-record-store.tsx,
// `whenSaved`), the one way: on the Pilot a success is said once the API
// has taken the write and never on a refusal, which is the store's toast in
// the API's words; on the browser's own path there is nothing to wait for.
// The governed status change of the generic workspace reports through it
// (#210): "<action> recorded" no longer goes out ahead of a 403.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { whenSaved } from "@/components/waste/business-record-store"

import type { BusinessRecord } from "../../data/business-modules"
import type { WriteOutcome } from "../records/server-records"

const row = { id: "customer-1", name: "Østerbro Housing" } as BusinessRecord
const refused: WriteOutcome = { kind: "refused", recordId: row.id, problem: { type: "about:blank", title: "Forbidden", status: 403, detail: "This account's role does not allow edit on customers.contacts" } }
const updated: WriteOutcome = { kind: "updated", record: row, serverId: "01a0d2a4-a280-700b-8000-000000000002" }

/** What ran, in order, once the outcome has settled. */
async function said(outcome: Promise<WriteOutcome> | undefined): Promise<string[]> {
  const ran: string[] = []
  whenSaved(outcome, () => ran.push("done"), () => ran.push("settled"))
  await outcome
  await Promise.resolve()
  return ran
}

describe("whenSaved", () => {
  test("on the browser's own path both run at once: there is nothing to wait for", () => {
    const ran: string[] = []
    whenSaved(undefined, () => ran.push("done"), () => ran.push("settled"))
    assert.deepEqual(ran, ["done", "settled"])
  })

  test("on the Pilot nothing is said before the API has answered", () => {
    const ran: string[] = []
    whenSaved(new Promise<WriteOutcome>(() => {}), () => ran.push("done"), () => ran.push("settled"))
    assert.deepEqual(ran, [])
  })

  test("a write the API took is said once it has answered", async () => {
    assert.deepEqual(await said(Promise.resolve(updated)), ["settled", "done"])
  })

  test("a refusal settles and is never said to have landed: its word is the store's toast alone", async () => {
    assert.deepEqual(await said(Promise.resolve(refused)), ["settled"])
  })
})
