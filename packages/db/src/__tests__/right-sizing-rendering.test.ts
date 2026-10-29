// Right-sizing proposals (M23b of #293) as drizzle-kit writes them: the
// proposal, keyed into its subscription, its product and the one it
// suggests, the subscription replacing it and the account that decided it,
// one open per subscription; then the migration, whose head is exactly those
// statements and whose tail is what the table owes the file. The file is
// found by its name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { rightSizingProposal } from "../schema/inspections"
import { auditTrail, RIGHT_SIZING_AUDITED } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { checksOf, ref } from "./rendering"
import { statementsFor } from "./specimen"

/** What the file owes below drizzle-kit's statements: the fence, the trigger and the audit trail. */
const handWritten = (): string[] => [...tenantFence(rightSizingProposal), ...touchUpdatedAt(rightSizingProposal), ...RIGHT_SIZING_AUDITED.flatMap(auditTrail)]

async function migration(): Promise<{ text: string; statements: string[] }> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_right_sizing\.sql$/.test(name))
  assert.ok(file !== undefined, "the right-sizing migration")
  const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
  return { text, statements: statementsOf(text) }
}

describe("right-sizing proposals as drizzle-kit writes them", () => {
  test("the migration's head is exactly drizzle-kit's statements, its tail what the table owes it, and nothing else", async () => {
    const { text, statements } = await migration()
    const generated = (await statementsFor({ rightSizingProposal })).map(normalised)
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), [...generated].sort())
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, generated.length + tail.length, "nothing else in the file")
    assert.ok(generated.includes(normalised(`CREATE UNIQUE INDEX "right_sizing_proposal_subscription_id_open_key" ON "wms"."right_sizing_proposal" USING btree ("company_id","subscription_id") WHERE ${ref("right_sizing_proposal", "status")} = 'open';`)), "one open per subscription")
    assert.match(text, /^-- Right-sizing proposals \(M23b of #293/)
  })
})

describe("the checks of the proposal", () => {
  test("a size suggests a product; a decision says who and when; a dismissal why; an approved size its day and replacement", () => {
    const column = (name: string) => ref("right_sizing_proposal", name)
    const checks = checksOf(rightSizingProposal)
    assert.equal(checks.get("right_sizing_proposal_suggestion_shape"), `(${column("direction")} in ('smaller', 'bigger')) = (${column("suggested_product_id")} is not null)`)
    assert.equal(checks.get("right_sizing_proposal_decided_shape"), `(${column("status")} <> 'open') = (${column("decided_at")} is not null and ${column("decided_by")} is not null)`)
    assert.equal(checks.get("right_sizing_proposal_dismiss_shape"), `(${column("status")} = 'dismissed') = (${column("dismiss_note")} is not null)`)
    assert.equal(checks.get("right_sizing_proposal_change_shape"), `(${column("changed_on")} is null) = (${column("replacement_subscription_id")} is null) and (${column("changed_on")} is null or ${column("status")} = 'approved')`)
  })
})
