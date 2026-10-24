// How a surface waits on a write's outcome (business-record-store.tsx,
// `whenSaved`), the one way: on the Pilot a success is said once the API
// has taken the write and never on a refusal, which is the store's toast in
// the API's words; on the browser's own path there is nothing to wait for.
// The governed status change of the generic workspace reports through it
// (#210): "<action> recorded" no longer goes out ahead of a 403.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { savedRow, whenSaved, type SavedOutcome } from "@/components/waste/business-record-store"

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

  // #263: a surface reads what the write did inside `done`, never by subscribing to the outcome a second time.
  test("done is handed the outcome, undefined on the browser's own path", async () => {
    const handed: unknown[] = []
    whenSaved(undefined, (saved) => handed.push(saved))
    const answer = Promise.resolve(updated)
    whenSaved(answer, (saved) => handed.push(saved))
    await answer
    await Promise.resolve()
    assert.deepEqual(handed, [undefined, updated])
  })
})

describe("savedRow", () => {
  const written = { ...row, name: "Østerbro Housing A/S" } as BusinessRecord
  const answered = { ...row, id: "customer-01a0d2a4", name: "Østerbro Housing A/S" } as BusinessRecord

  test("is the API's answer, mapped, for an update and for nothing moved", () => {
    assert.equal(savedRow(updated as SavedOutcome, written), row)
    assert.equal(savedRow({ kind: "unchanged", record: row }, written), row)
  })

  test("a create's under the id the workspace minted, as the store files it, never the adapter's", () => {
    const created: SavedOutcome = { kind: "created", record: answered, serverId: "01a0d2a4", optimisticId: "customer-mint-1" }
    assert.deepEqual(savedRow(created, written), { ...answered, id: "customer-mint-1" })
  })

  test("the row as written on the browser's own path, and where the API took the write but its answer could not be shown", () => {
    assert.equal(savedRow(undefined, written), written)
    assert.equal(savedRow({ kind: "landed", recordId: row.id, serverId: "01a0d2a4", problem: refused.kind === "refused" ? refused.problem : { type: "about:blank", title: "", status: 0 } }, written), written)
  })
})
