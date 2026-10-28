// The driver instructions as drizzle-kit writes them: a nullable text column
// on `property` and on `shared_collection_point`, two ALTER TABLE statements
// diffed from the two tables as 0018 left them (0004's spelling, spelled
// below), since an applied file is never edited; registry-rendering.test.ts
// maps today's tables back (`CHANGED_IN_0022`). Then migration 0022, which is
// exactly those statements: no table is new, so nothing is hand-written, and
// an added nullable column loses nothing, so no guard. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import {
  PROPERTY_KINDS,
  PROPERTY_STATUSES,
  SHARED_COLLECTION_POINT_ACCESS_MODES,
  SHARED_COLLECTION_POINT_BILLING_MODES,
  SHARED_COLLECTION_POINT_KINDS,
  SHARED_COLLECTION_POINT_OPERATING_MODELS,
  SHARED_COLLECTION_POINT_STATUSES,
} from "@waste/domain/registry/vocabulary"
import { sql } from "drizzle-orm"
import { integer, text, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import { tableObjectName } from "../names"
import { oneOf, positive } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { customer, sharedCollectionPoint } from "../schema/customers"
import { geometry, validGeometry } from "../schema/geometry"
import { company, project } from "../schema/organisation"
import { companyReference, projectKey, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { wms } from "../schema/wms"
import { normalised, statementsOf } from "../sql/hand-written"
import { statementsBetween } from "./specimen"

const MIGRATION = "0022_driver_instructions.sql"

const propertyColumns = {
  ...id,
  ...projectScoped,
  ...timestamps,
  name: text().notNull(),
  address: text().notNull(),
  registryId: text(),
  kind: text().notNull(),
  location: geometry.point(),
  notes: text(),
}

/** property as 0004 made it and 0018 still had it: no instructions for the driver. */
const propertyAsOf0018 = wms.table("property", { ...propertyColumns, status: text().notNull() }, (t) => [
  companyReference(t, company),
  tenantReference(t, [t.projectId], project),
  tenantUnique(t, t.projectId, t.name),
  projectKey(t),
  oneOf(t.kind, PROPERTY_KINDS),
  oneOf(t.status, PROPERTY_STATUSES),
  validGeometry(t.location),
  uniqueIndex(tableObjectName(t.companyId.table, "registry_id_idx", "property")).on(t.companyId, t.registryId).where(sql`${t.registryId} is not null`),
])

/** property as 0022 left it, with the instructions, before 0056's service window (O14 of #290). */
const propertyAsOf0022 = wms.table("property", { ...propertyColumns, driverInstructions: text(), status: text().notNull() }, (t) => [
  companyReference(t, company),
  tenantReference(t, [t.projectId], project),
  tenantUnique(t, t.projectId, t.name),
  projectKey(t),
  oneOf(t.kind, PROPERTY_KINDS),
  oneOf(t.status, PROPERTY_STATUSES),
  validGeometry(t.location),
  uniqueIndex(tableObjectName(t.companyId.table, "registry_id_idx", "property")).on(t.companyId, t.registryId).where(sql`${t.registryId} is not null`),
])

/** shared_collection_point as 0004 made it and 0018 still had it. */
const pointAsOf0018 = wms.table(
  "shared_collection_point",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    kind: text().notNull(),
    address: text().notNull(),
    location: geometry.point().notNull(),
    eligibilityDistanceM: integer(),
    operatingModel: text().notNull(),
    accessMode: text().notNull(),
    accessConditions: text(),
    availability: text(),
    billingMode: text().notNull(),
    responsibleCustomerId: uuid(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.responsibleCustomerId], customer),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    validGeometry(t.location),
    positive(t.eligibilityDistanceM),
    oneOf(t.kind, SHARED_COLLECTION_POINT_KINDS),
    oneOf(t.operatingModel, SHARED_COLLECTION_POINT_OPERATING_MODELS),
    oneOf(t.accessMode, SHARED_COLLECTION_POINT_ACCESS_MODES),
    oneOf(t.billingMode, SHARED_COLLECTION_POINT_BILLING_MODES),
    oneOf(t.status, SHARED_COLLECTION_POINT_STATUSES),
    tenantIndex(t, t.responsibleCustomerId),
  ],
)

const referenced = { company, project, customer }

describe("the driver instructions as drizzle-kit writes them", () => {
  const generated = statementsBetween({ ...referenced, property: propertyAsOf0018, sharedCollectionPoint: pointAsOf0018 }, { ...referenced, property: propertyAsOf0022, sharedCollectionPoint })

  test("one nullable text column on each place, nothing else moved", async () => {
    assert.deepEqual(await generated, [
      'ALTER TABLE "wms"."property" ADD COLUMN "driver_instructions" text;',
      'ALTER TABLE "wms"."shared_collection_point" ADD COLUMN "driver_instructions" text;',
    ])
  })

  test("migration 0022 is exactly those statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, (await generated).map(normalised))
  })
})
