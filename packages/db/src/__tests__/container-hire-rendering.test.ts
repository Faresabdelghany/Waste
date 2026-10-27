// Container hire (M14 of #293) as drizzle-kit writes it: the product sold by
// the `day` with its free days, held to a hire product and to a year; the
// billable event's two new kinds — a work order's `job`, which names its
// stop, and the billing run's `hire`, which names its subscription and its
// placement through the container, the placement's project key — with the
// run's key per placement and month; and `work_order_product`, a project's
// product for each work order's service, a service at most once in a project.
// The kind's, the origin's and the charge's shapes are respelt whole, as
// Postgres has no ALTER for a check; finance-rendering.test.ts spells them out
// and registry-rendering.test.ts the product, so here they are read from the
// schema, less what a later migration added: M5b's `pickup-exception` kind
// (#293, 0046), its value and its clause of the kind's shape, and the
// recycling-centre visit's `visit` kind and unit (#393, 0052), its clause of
// the kind's shape and the product's value. Then the migration, which has to be exactly those statements and
// below them the new table's fence, its `updated_at` trigger and its audit
// trigger, a set of its project read under `commercial.products`. The file is
// found by its name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { WORK_ORDER_SERVICES } from "@waste/domain/execution/vocabulary"
import { FREE_DAYS_MAX } from "@waste/domain/finance/hire"
import { BILLABLE_EVENT_KINDS } from "@waste/domain/finance/vocabulary"
import { PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { product } from "../schema/catalogue"
import { billableEvent, workOrderProduct } from "../schema/finance"
import { auditTrail, CONTAINER_HIRE_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, foreignKey, index, oneOfCheck, partialUniqueIndex, projectFk, projectFkTo, ref, uniqueKey } from "./rendering"

const alter = (table: string, statement: string): string => `ALTER TABLE "wms"."${table}" ${statement};`
const respelt = (table: string, checks: Map<string, string>, name: string): string => alter(table, `ADD CONSTRAINT "${name}" CHECK (${checks.get(name)})`)

/** The product's new check: no free days, or a hire product's from none to a year. */
const FREE_DAYS_SHAPE = `${ref("product", "free_days")} is null or (${ref("product", "unit")} = 'day' and ${ref("product", "free_days")} between 0 and 366)`

/** The billable event's three shapes 0044 respells, the order drizzle-kit writes them in. */
const EVENT_SHAPES = ["billable_event_kind_shape", "billable_event_origin_shape", "billable_event_charge_shape"]

/** The event's kinds as 0044 wrote them: today's through `hire`, before M5b's `pickup-exception` (#293). */
const KINDS_AS_OF_0044 = BILLABLE_EVENT_KINDS.slice(0, BILLABLE_EVENT_KINDS.indexOf("hire") + 1)

/** The product's units as 0044 wrote them: today's before the recycling-centre visit's (#393). */
const UNITS_AS_OF_0044 = PRODUCT_UNITS.filter((unit) => unit !== "visit")

/** The clause M5b added to the kind's shape (#293), which 0044's spelling lacks. */
const EXCEPTION_CLAUSE = ` when 'pickup-exception' then ${ref("billable_event", "pickup_id")} is not null and ${ref("billable_event", "ticket_id")} is null and ${ref("billable_event", "reverses_event_id")} is null`

/** The clause 0052 added to the kind's shape (#393), which 0044's spelling lacks too. */
const VISIT_CLAUSE = ` when 'visit' then ${ref("billable_event", "visit_id")} is not null and ${ref("billable_event", "pickup_id")} is null and ${ref("billable_event", "ticket_id")} is null and ${ref("billable_event", "reverses_event_id")} is null`

/** The event's checks as 0044 spelled them: today's, the kind's shape less M5b's clause and 0052's. */
const checksAsOf0044 = (): Map<string, string> => {
  const checks = new Map(checksOf(billableEvent))
  const kindShape = checks.get("billable_event_kind_shape") ?? ""
  assert.ok(kindShape.includes(EXCEPTION_CLAUSE), "today's kind shape carries M5b's clause")
  assert.ok(kindShape.includes(VISIT_CLAUSE), "today's kind shape carries the visit's clause")
  checks.set("billable_event_kind_shape", kindShape.replace(EXCEPTION_CLAUSE, "").replace(VISIT_CLAUSE, ""))
  return checks
}

/** Migration 0044 as drizzle-kit wrote it. */
const generated = (): string[] => [
  createTable("work_order_product", "project", [
    '"service" text NOT NULL',
    '"product_id" uuid NOT NULL',
    uniqueKey("work_order_product_project_id_service_key", "company_id", "project_id", "service"),
    oneOfCheck("work_order_product", "service", ...WORK_ORDER_SERVICES),
  ]),
  alter("product", 'DROP CONSTRAINT "product_unit_one_of"'),
  ...["billable_event_kind_one_of", ...EVENT_SHAPES].map((name) => alter("billable_event", `DROP CONSTRAINT "${name}"`)),
  alter("product", 'ADD COLUMN "free_days" integer'),
  alter("billable_event", 'ADD COLUMN "container_id" uuid'),
  alter("billable_event", 'ADD COLUMN "placement_id" uuid'),
  companyFk("work_order_product"),
  projectFk("work_order_product"),
  projectFkTo("work_order_product", "product_id", "product"),
  index("work_order_product", "work_order_product_product_id_idx", "company_id", "product_id"),
  foreignKey("billable_event", "billable_event_container_id_placement_id_fk", ["company_id", "project_id", "container_id", "placement_id"], "container_service_placement", ["company_id", "project_id", "container_id", "id"]),
  partialUniqueIndex("billable_event", "billable_event_hire_charge_idx", ["company_id", "placement_id", "charge_period_from"], `${ref("billable_event", "kind")} = 'hire'`),
  index("billable_event", "billable_event_placement_id_idx", "company_id", "placement_id"),
  alter("product", `ADD CONSTRAINT "product_free_days_shape" CHECK (${FREE_DAYS_SHAPE})`),
  alter("product", `ADD ${oneOfCheck("product", "unit", ...UNITS_AS_OF_0044)}`),
  alter("billable_event", `ADD ${oneOfCheck("billable_event", "kind", ...KINDS_AS_OF_0044)}`),
  ...EVENT_SHAPES.map((name) => respelt("billable_event", checksAsOf0044(), name)),
]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_container_hire\.sql$/.test(name))
  assert.ok(file !== undefined, "the container hire's migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

describe("container hire as drizzle-kit writes it", () => {
  test("the migration is exactly drizzle-kit's statements, then the new table's fence, its updated_at trigger and its audit trigger, a set of its project", async () => {
    const audit = CONTAINER_HIRE_AUDITED.flatMap(auditTrail)
    assert.deepEqual(await migration(), [...generated(), ...handWrittenStatements(workOrderProduct), ...audit].map(normalised))
    assert.deepEqual(audit, [`CREATE TRIGGER "work_order_product_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."work_order_product" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');`])
  })

  test("the vocabularies the checks spell: the five work orders, the day, and the two kinds", () => {
    assert.deepEqual([...WORK_ORDER_SERVICES], ["deliver", "remove", "swap", "repair", "wash"])
    assert.deepEqual([...UNITS_AS_OF_0044], ["pickup", "month", "job", "day"])
    assert.deepEqual(KINDS_AS_OF_0044.slice(-2), ["job", "hire"])
    assert.equal(FREE_DAYS_MAX, 366)
  })

  test("the product's free days render without parameters, a hire's alone", () => {
    assert.equal(checksOf(product).get("product_free_days_shape"), FREE_DAYS_SHAPE)
  })
})
