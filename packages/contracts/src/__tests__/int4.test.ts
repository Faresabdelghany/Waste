// Every whole number a body writes fits the `integer` column it lands in:
// zod's `int` stops at JavaScript's safe integers, far past Postgres's
// `integer`, and a number between the two would reach the database as 22003
// and come back a 500. The shared shapes are held at the bound here; then
// every write body of every module — a strict object, which is what a body
// is (resource.ts) — is walked, and each whole number in it must say so.
import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import * as accessModule from "../access"
import * as agreementsModule from "../agreements"
import * as alertsModule from "../alerts"
import * as allocationsModule from "../allocations"
import * as auditModule from "../audit"
import * as availabilityModule from "../availability"
import * as billableEventsModule from "../billable-events"
import * as billingModule from "../billing"
import * as catalogueModule from "../catalogue"
import * as applicationsModule from "../applications"
import * as collectionCalendarsModule from "../collection-calendars"
import * as containersModule from "../containers"
import * as customersModule from "../customers"
import * as datesModule from "../dates"
import * as driverCommandsModule from "../driver-commands"
import * as dropOffPointsModule from "../drop-off-points"
import * as emissionsModule from "../emissions"
import * as executionModule from "../execution"
import * as financeModule from "../finance"
import * as fleetModule from "../fleet"
import * as generationModule from "../generation"
import * as geojsonModule from "../geojson"
import * as healthModule from "../health"
import * as idsModule from "../ids"
import * as importsModule from "../imports"
import * as invoicesModule from "../invoices"
import * as meModule from "../me"
import * as organisationModule from "../organisation"
import * as outboxModule from "../outbox"
import * as paginationModule from "../pagination"
import * as paymentsModule from "../payments"
import * as permissionsModule from "../permissions"
import * as pickupsModule from "../pickups"
import * as placesModule from "../places"
import * as planningModule from "../planning"
import * as planningAreasModule from "../planning-areas"
import * as plansModule from "../plans"
import * as priceListsModule from "../price-lists"
import * as problemModule from "../problem"
import * as proofObjectsModule from "../proof-objects"
import * as proofsModule from "../proofs"
import * as publicModule from "../public"
import * as queriesModule from "../queries"
import * as reportsModule from "../reports"
import * as resolutionModule from "../resolution"
import * as resourceModule from "../resource"
import * as resourcesModule from "../resources"
import * as routeSchemesModule from "../route-schemes"
import * as routesModule from "../routes"
import * as routingPreviewModule from "../routing-preview"
import * as routingQuotaModule from "../routing-quota"
import * as serviceAreasModule from "../service-areas"
import * as serviceProviderPricesModule from "../service-provider-prices"
import * as pickupExceptionsModule from "../pickup-exceptions"
import * as sessionsModule from "../sessions"
import * as settlementsModule from "../settlements"
import * as sortingGuideModule from "../sorting-guide"
import * as stockModule from "../stock"
import * as sustainabilityModule from "../sustainability"
import * as textModule from "../text"
import * as ticketSlaModule from "../ticket-sla"
import * as ticketsModule from "../tickets"
import * as unloadsModule from "../unloads"
import * as validityModule from "../validity"
import * as vehicleTypesModule from "../vehicle-types"
import * as weightControlModule from "../weight-control"
import * as workOrderChargesModule from "../work-order-charges"
import { Int4, INT4_MAX, INT4_MIN, NonNegativeInt, NonNegativeMinor, NonNegativeTotal, PositiveInt } from "../resource"
import { ServiceProviderPriceIndex } from "../service-provider-prices"

/** Every module of the package by its file's name: imported by name, since the purity gate refuses an import it cannot read, and held to the directory below. */
const MODULES: Readonly<Record<string, Record<string, unknown>>> = {
  "applications": applicationsModule,
  "access": accessModule,
  "agreements": agreementsModule,
  "alerts": alertsModule,
  "allocations": allocationsModule,
  "audit": auditModule,
  "availability": availabilityModule,
  "billable-events": billableEventsModule,
  "billing": billingModule,
  "catalogue": catalogueModule,
  "collection-calendars": collectionCalendarsModule,
  "containers": containersModule,
  "customers": customersModule,
  "dates": datesModule,
  "driver-commands": driverCommandsModule,
  "drop-off-points": dropOffPointsModule,
  "emissions": emissionsModule,
  "execution": executionModule,
  "finance": financeModule,
  "fleet": fleetModule,
  "generation": generationModule,
  "geojson": geojsonModule,
  "health": healthModule,
  "ids": idsModule,
  "imports": importsModule,
  "invoices": invoicesModule,
  "me": meModule,
  "organisation": organisationModule,
  "outbox": outboxModule,
  "pagination": paginationModule,
  "payments": paymentsModule,
  "permissions": permissionsModule,
  "pickup-exceptions": pickupExceptionsModule,
  "pickups": pickupsModule,
  "places": placesModule,
  "planning": planningModule,
  "planning-areas": planningAreasModule,
  "plans": plansModule,
  "price-lists": priceListsModule,
  "problem": problemModule,
  "proof-objects": proofObjectsModule,
  "proofs": proofsModule,
  "public": publicModule,
  "queries": queriesModule,
  "reports": reportsModule,
  "resolution": resolutionModule,
  "resource": resourceModule,
  "resources": resourcesModule,
  "route-schemes": routeSchemesModule,
  "routes": routesModule,
  "routing-preview": routingPreviewModule,
  "routing-quota": routingQuotaModule,
  "service-areas": serviceAreasModule,
  "service-provider-prices": serviceProviderPricesModule,
  "sessions": sessionsModule,
  "settlements": settlementsModule,
  "sorting-guide": sortingGuideModule,
  "stock": stockModule,
  "sustainability": sustainabilityModule,
  "text": textModule,
  "ticket-sla": ticketSlaModule,
  "tickets": ticketsModule,
  "unloads": unloadsModule,
  "validity": validityModule,
  "vehicle-types": vehicleTypesModule,
  "weight-control": weightControlModule,
  "work-order-charges": workOrderChargesModule,
}

describe("the shared whole numbers", () => {
  test("a positive and a non-negative one stop at the integer's bound, and a refusal names the bound", () => {
    for (const schema of [PositiveInt, NonNegativeInt, NonNegativeMinor]) {
      assert.equal(schema.safeParse(INT4_MAX).success, true)
      const refused = schema.safeParse(INT4_MAX + 1)
      assert.equal(refused.success, false)
      assert.match(refused.error?.issues[0]?.message ?? "", /2147483647/)
    }
  })

  test("a signed one holds both of the integer's bounds, and a report's sum, never written, holds neither", () => {
    assert.equal(Int4.safeParse(INT4_MIN).success, true)
    assert.equal(Int4.safeParse(INT4_MIN - 1).success, false)
    assert.equal(Int4.safeParse(INT4_MAX + 1).success, false)
    assert.equal(NonNegativeTotal.safeParse(INT4_MAX + 1).success, true)
  })

  test("an index's basis points are an integer of either sign", () => {
    const body = (basisPoints: number) => ({ label: "CPI", basisPoints, base: "bid", appliedFrom: "2026-07-01" })
    assert.equal(ServiceProviderPriceIndex.safeParse(body(-500)).success, true)
    assert.deepEqual(ServiceProviderPriceIndex.safeParse(body(INT4_MAX + 1)).error?.issues.map((issue) => issue.path.join(".")), ["basisPoints"])
  })
})

// A zod 4 schema by the little of it the walk reads: its definition's kind
// and the schemas it holds, and a number's bounds.
type Node = { def: Def; isInt?: boolean | null; minValue?: number | null; maxValue?: number | null }
type Def = {
  type: string
  shape?: Record<string, Node>
  catchall?: Node
  innerType?: Node
  in?: Node
  out?: Node
  element?: Node
  items?: Node[]
  options?: Node[]
  valueType?: Node
  left?: Node
  right?: Node
  getter?: () => Node
}

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as { def?: { type?: unknown } }).def?.type === "string"

/** Whether a schema, under its wrappers, is a strict object: a write body. */
function isBody(node: Node, depth = 0): boolean {
  if (depth > 16) return false
  const { def } = node
  if (def.type === "object") return def.catchall?.def.type === "never"
  // A union of bodies is a body: one of several shapes a request may take.
  if (def.type === "union") return (def.options ?? []).some((option) => isBody(option, depth + 1))
  const inner = def.innerType ?? def.in
  return inner !== undefined && isBody(inner, depth + 1)
}

/** Every whole number inside a schema, by the path a body reaches it at, unbounded ones first to fail. */
function wholeNumbers(node: Node, path: string, seen = new Set<Node>()): { path: string; node: Node }[] {
  if (seen.has(node)) return []
  seen.add(node)
  const { def } = node
  if (def.type === "number") return node.isInt ? [{ path, node }] : []
  const children: [string, Node | undefined][] = [
    ...Object.entries(def.shape ?? {}).map(([key, child]) => [`${path}.${key}`, child] as [string, Node]),
    [path, def.innerType],
    [path, def.in],
    // A pipe's out side is what the value becomes, `.transform(Number).pipe(z.int())`'s integer included.
    [path, def.out],
    [`${path}[]`, def.element],
    ...(def.items ?? []).map((child, index) => [`${path}.${index}`, child] as [string, Node]),
    ...(def.options ?? []).map((child) => [path, child] as [string, Node]),
    [`${path}{}`, def.valueType],
    [path, def.left],
    [path, def.right],
    [path, def.getter?.()],
  ]
  return children.flatMap(([childPath, child]) => (child === undefined ? [] : wholeNumbers(child, childPath, seen)))
}

describe("every write body", () => {
  test("holds each whole number it takes to the integer's bounds, so none reaches the database as 22003", async () => {
    // A module added to the package and not to the table is a module the walk would miss.
    const files = (await readdir(join(import.meta.dirname, ".."))).filter((name) => name.endsWith(".ts")).map((name) => name.replace(/\.ts$/, ""))
    assert.deepEqual(Object.keys(MODULES).sort(), files.sort())
    const unbounded: string[] = []
    let bodies = 0
    for (const [name, exported] of Object.entries(MODULES)) {
      for (const [exportName, value] of Object.entries(exported)) {
        if (!isNode(value) || !isBody(value)) continue
        bodies += 1
        for (const { path, node } of wholeNumbers(value, `${name}.${exportName}`)) {
          if ((node.maxValue ?? Infinity) > INT4_MAX || (node.minValue ?? -Infinity) < INT4_MIN) unbounded.push(path)
        }
      }
    }
    assert.ok(bodies > 50, `walked ${bodies} bodies`)
    assert.deepEqual(unbounded, [])
  })
})
