// Ticket work priced (#291 C3) as drizzle-kit writes it: a project's charge
// for each ticket kind's work, `ticket_kind_product` — a kind at most once in
// a project, its product the project's — and the ticket's own
// `charge_product_id`, the product its completion named, with its key, its
// index and `ticket_charge_shape` holding it to a resolution Finance charges
// for. The ticket is diffed from its 0031 spelling (ticket-as-of.ts), since an
// applied file is never edited and the schema module spells the table as it
// is today. Then the migration, which has to be exactly those statements and
// below them the new table's fence, its `updated_at` trigger and its audit
// trigger — a set of its project, read under `commercial.products`. The file
// is found by its name, not its number, which it takes at its turn. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { BILLABLE_RESOLUTIONS, TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { agreement } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { container } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { ticketKindProduct } from "../schema/finance"
import { driver } from "../schema/fleet"
import { company, project } from "../schema/organisation"
import { ticket } from "../schema/resolution"
import { auditTrail, TICKET_CHARGE_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, index, list, oneOfCheck, projectFk, projectFkTo, ref, uniqueKey } from "./rendering"
import { statementsBetween } from "./specimen"
import { ticketAsOf } from "./ticket-as-of"

const referenced = { company, project, userAccount, agreement, product, container, customer, property, sharedCollectionPoint, route, pickup, driver }

/** The ticket's new check: the resolution named not null, since `null in (...)` is null and a null check passes. */
const CHARGE_SHAPE = `${ref("ticket", "charge_product_id")} is null or (${ref("ticket", "resolution")} is not null and ${ref("ticket", "resolution")} in (${list(...BILLABLE_RESOLUTIONS)}))`

const generated = () => statementsBetween({ ...referenced, ticket: ticketAsOf("0031") }, { ...referenced, ticket, ticketKindProduct })

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_ticket_charges\.sql$/.test(name))
  assert.ok(file !== undefined, "the ticket charges' migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

describe("ticket work priced as drizzle-kit writes it", () => {
  test("the charge per kind, a kind once in a project, and the product a completion names, held to a re-collection or a service", async () => {
    assert.deepEqual(await generated(), [
      createTable("ticket_kind_product", "project", [
        '"ticket_kind" text NOT NULL',
        '"product_id" uuid NOT NULL',
        uniqueKey("ticket_kind_product_project_id_ticket_kind_key", "company_id", "project_id", "ticket_kind"),
        oneOfCheck("ticket_kind_product", "ticket_kind", ...TICKET_KINDS),
      ]),
      'ALTER TABLE "wms"."ticket" ADD COLUMN "charge_product_id" uuid;',
      companyFk("ticket_kind_product"),
      projectFk("ticket_kind_product"),
      projectFkTo("ticket_kind_product", "product_id", "product"),
      index("ticket_kind_product", "ticket_kind_product_product_id_idx", "company_id", "product_id"),
      projectFkTo("ticket", "charge_product_id", "product"),
      index("ticket", "ticket_charge_product_id_idx", "company_id", "charge_product_id"),
      `ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_charge_shape" CHECK (${CHARGE_SHAPE});`,
    ])
  })

  test("the migration is exactly that, then the new table's fence, its updated_at trigger and its audit trigger, a set of its project", async () => {
    const audit = TICKET_CHARGE_AUDITED.flatMap(auditTrail)
    assert.deepEqual(await migration(), [...(await generated()), ...handWrittenStatements(ticketKindProduct), ...audit].map(normalised))
    assert.deepEqual(audit, [`CREATE TRIGGER "ticket_kind_product_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."ticket_kind_product" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');`])
  })

  test("the check renders without parameters, over the domain's billable resolutions", () => {
    assert.equal(checksOf(ticket).get("ticket_charge_shape"), CHARGE_SHAPE)
    assert.deepEqual([...BILLABLE_RESOLUTIONS], ["recollected", "serviced"])
  })
})
