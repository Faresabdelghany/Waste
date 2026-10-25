// The weighbridge in the office (O9 of #290) as drizzle-kit writes it: the
// project's tolerance, defaulting to the domain's 5 and held to 1..100, and
// the unload's refusal, its reason from the domain's list and a note that
// goes with it — six statements diffed from the project as 0037 left it to
// the project as 0045 did (project-as-of.ts) and the unload as 0010 did
// (unload-as-of.ts), since an applied file is never edited. Then migration
// 0045, which is exactly those statements under its header: no table is new,
// so nothing is hand-written; every project takes the default, and no unload
// present is refused, so nothing is guarded. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DEFAULT_WEIGHT_TOLERANCE_PERCENT } from "@waste/domain/execution/unloads"
import { UNLOAD_REFUSAL_REASONS } from "@waste/domain/execution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { wasteFraction } from "../schema/catalogue"
import { route, session, unload } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { unloadingStation } from "../schema/places"
import { normalised, statementsOf } from "../sql/hand-written"
import { projectAsOf } from "./project-as-of"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"
import { unloadAsOf0010 } from "./unload-as-of"
import { REFUSAL_REASONS, REFUSAL_SHAPE, TOLERANCE_RANGE } from "./weighbridge-shapes"

const MIGRATION = "0045_weighbridge.sql"

const referenced = { company, route, session, unloadingStation, wasteFraction, userAccount }

describe("the weighbridge as drizzle-kit writes it", () => {
  const generated = statementsBetween({ ...referenced, project: projectAsOf("0037"), unload: unloadAsOf0010 }, { ...referenced, project: projectAsOf("0045"), unload })

  test("the project's tolerance and the unload's refusal, each held by its checks", async () => {
    assert.deepEqual(await generated, [
      `ALTER TABLE "wms"."project" ADD COLUMN "weight_tolerance_percent" integer DEFAULT ${DEFAULT_WEIGHT_TOLERANCE_PERCENT} NOT NULL;`,
      'ALTER TABLE "wms"."unload" ADD COLUMN "refusal_reason" text;',
      'ALTER TABLE "wms"."unload" ADD COLUMN "refusal_note" text;',
      `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_weight_tolerance_percent_range" CHECK (${TOLERANCE_RANGE});`,
      `ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_refusal_reason_one_of" CHECK (${ref("unload", "refusal_reason")} in (${REFUSAL_REASONS.map((reason) => `'${reason}'`).join(", ")}));`,
      `ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_refusal_shape" CHECK (${REFUSAL_SHAPE});`,
    ])
  })

  test("the reasons are the domain's, and the shapes the tables'", () => {
    assert.deepEqual([...REFUSAL_REASONS], [...UNLOAD_REFUSAL_REASONS])
    assert.equal(checksOf(unload).get("unload_refusal_shape"), REFUSAL_SHAPE)
    assert.equal(checksOf(project).get("project_weight_tolerance_percent_range"), TOLERANCE_RANGE)
  })

  test("migration 0045 is exactly those statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, (await generated).map(normalised))
  })
})
