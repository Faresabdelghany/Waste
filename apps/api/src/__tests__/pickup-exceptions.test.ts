import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { CODE_WITH_CONTAMINATION, PickupDetail } from "@waste/contracts/pickups"
import { ContaminantCode, PickupExceptionHistory, PickupExceptionRule } from "@waste/contracts/pickup-exceptions"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { proofOfService } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { CODE_NOT_FOR_FRACTION, NOT_A_CODE, NOT_A_STEP } from "../routes/pickup-exceptions"
import { retiredCode, unofferedStep } from "../routes/statuses"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, TOWN_HALL, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the corrections append, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const CodePage = Page(ContaminantCode)
const RulePage = Page(PickupExceptionRule)

/** The request's clock, pinned: noon on the fixtures' Monday. */
const NOON = new Date("2026-10-05T12:00:00Z")

describe("the Pickup Exceptions (M5 of #293)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** Copenhagen Central's products: two sold per job as additional services, one monthly, one still a draft. */
  let products: { warning: string; fee: string; monthly: string; draft: string }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    products = { warning: testId(), fee: testId(), monthly: testId(), draft: testId() }
    const copenhagen = a.projects.copenhagen.id
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(product).values([
        { id: products.warning, companyId: a.companyId, projectId: copenhagen, name: "Contamination warning fee", kind: "additional-service", unit: "job", status: "active" },
        { id: products.fee, companyId: a.companyId, projectId: copenhagen, name: "Contamination fee", kind: "additional-service", unit: "job", status: "active" },
        { id: products.monthly, companyId: a.companyId, projectId: copenhagen, name: "Bin rental", kind: "recurring-service", unit: "month", status: "active" },
        { id: products.draft, companyId: a.companyId, projectId: copenhagen, name: "Contamination fee (draft)", kind: "additional-service", unit: "job", status: "draft" },
      ])
    })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const post = (call: Call, path: string, body: unknown) => call(path, { method: "POST", body })
  const patch = (call: Call, path: string, body: unknown) => call(path, { method: "PATCH", body })
  const put = (call: Call, path: string, body: unknown) => call(path, { method: "PUT", body })
  const newCode = async (values: Record<string, unknown> = {}): Promise<ContaminantCode> => {
    const slug = `code-${testId().slice(-8)}`
    return await created(olivia, "/contaminant-codes", await post(olivia, "/contaminant-codes", { code: slug, name: `Code ${slug}`, ...values }), ContaminantCode)
  }

  describe("contaminant codes", () => {
    test("are the company's own, active unless said and for every fraction unless narrowed; a patch renames or retires one, and the fractions are PUT whole", async () => {
      const plastic = await newCode({ code: "plastic-in-organic", name: "Plastic in organic waste" })
      assert.deepEqual([plastic.code, plastic.status, plastic.wasteFractionIds], ["plastic-in-organic", "active", []])
      const glass = await newCode({ wasteFractionIds: [ex.fractions.glass.id] })
      assert.deepEqual(glass.wasteFractionIds, [ex.fractions.glass.id])

      assert.match((await refused(await post(olivia, "/contaminant-codes", { code: "plastic-in-organic", name: "Another" }), 409)).detail ?? "", /already has a contaminant code "plastic-in-organic"/)
      assert.deepEqual((await refused(await post(olivia, "/contaminant-codes", { code: "x-foreign", name: "Foreign", wasteFractionIds: [testId()] }), 400)).errors?.map((error) => error.path), ["wasteFractionIds.0"])

      const retired = ContaminantCode.parse(await (await patch(olivia, `/contaminant-codes/${plastic.id}`, { status: "inactive" })).json())
      assert.equal(retired.status, "inactive")
      assert.ok((await refused(await patch(olivia, `/contaminant-codes/${plastic.id}`, { code: "renamed" }), 400)).errors?.some((error) => error.path === "code"), "the code is the slug the system quotes")

      const narrowed = ContaminantCode.parse(await (await put(olivia, `/contaminant-codes/${plastic.id}/fractions`, { wasteFractionIds: [ex.fractions.residual.id] })).json())
      assert.deepEqual(narrowed.wasteFractionIds, [ex.fractions.residual.id])
      const read = ContaminantCode.parse(await (await olivia(`/contaminant-codes/${plastic.id}`)).json())
      assert.deepEqual([read.status, read.wasteFractionIds], ["inactive", [ex.fractions.residual.id]], "the read says what the writes answered")

      const inactive = CodePage.parse(await (await olivia("/contaminant-codes?status=inactive&limit=200")).json()).items.map((code) => code.id)
      assert.ok(inactive.includes(plastic.id) && !inactive.includes(glass.id))
      await refused(await other(`/contaminant-codes/${plastic.id}`), 404)
      assert.match((await refused(await ungranted("/contaminant-codes"), 403)).detail ?? "", /view on configure\.master/)
    })
  })

  describe("charge rules", () => {
    const rule = (values: Record<string, unknown> = {}) => ({ projectId: a.projects.copenhagen.id, outcome: "failed", reason: "contamination", freeCount: 1, windowDays: 365, ladder: [products.warning, products.fee], validFrom: "2027-01-01", ...values })

    test("are a project's, holding each step to an additional service of the project sold per job and offered, and each code to the company's and active", async () => {
      const made = await created(olivia, "/pickup-exception-rules", await post(olivia, "/pickup-exception-rules", rule()), PickupExceptionRule)
      assert.deepEqual([made.ladder, made.contaminantCodeId, made.validTo], [[products.warning, products.fee], null, null])

      assert.deepEqual((await refused(await post(olivia, "/pickup-exception-rules", rule({ ladder: [products.warning, products.monthly] })), 400)).errors, [{ path: "ladder.1", message: NOT_A_STEP }])
      assert.deepEqual((await refused(await post(olivia, "/pickup-exception-rules", rule({ ladder: [testId()] })), 400)).errors, [{ path: "ladder.0", message: NOT_A_STEP }], "a product of no project here")
      assert.equal((await refused(await post(olivia, "/pickup-exception-rules", rule({ reason: "other", ladder: [products.draft] })), 409)).detail, unofferedStep(1, "draft"))
      assert.deepEqual((await refused(await post(olivia, "/pickup-exception-rules", rule({ contaminantCodeId: testId() })), 400)).errors, [{ path: "contaminantCodeId", message: NOT_A_CODE }])
      const retired = await newCode({ status: "inactive" })
      assert.equal((await refused(await post(olivia, "/pickup-exception-rules", rule({ contaminantCodeId: retired.id })), 409)).detail, retiredCode(retired.code, "a rule"))
      assert.deepEqual((await refused(await post(olivia, "/pickup-exception-rules", rule({ projectId: b.projects.copenhagen.id })), 400)).errors?.map((error) => error.path), ["projectId"])
    })

    test("two alike are never in force at once; a patch moves the free count, the ladder and the end, never the key", async () => {
      const first = await created(olivia, "/pickup-exception-rules", await post(olivia, "/pickup-exception-rules", rule({ reason: "inaccessible", validFrom: "2027-01-01", validTo: "2027-07-01" })), PickupExceptionRule)
      assert.match((await refused(await post(olivia, "/pickup-exception-rules", rule({ reason: "inaccessible", validFrom: "2027-06-01" })), 409)).detail ?? "", /already in force over part of that period/)
      const next = await created(olivia, "/pickup-exception-rules", await post(olivia, "/pickup-exception-rules", rule({ reason: "inaccessible", validFrom: "2027-07-01" })), PickupExceptionRule)
      assert.equal(next.validFrom, "2027-07-01", "a rule ending on the day the next starts does not overlap it")

      const amended = PickupExceptionRule.parse(await (await patch(olivia, `/pickup-exception-rules/${first.id}`, { freeCount: 0, ladder: [products.fee] })).json())
      assert.deepEqual([amended.freeCount, amended.ladder], [0, [products.fee]])
      // The fee is withdrawn: the step that already charged it keeps it, a new step naming it is refused.
      await withCompany(pool.db, a.companyId, async (tx: Tx) => tx.update(product).set({ status: "inactive" }).where(eq(product.id, products.fee)))
      try {
        assert.equal((await patch(olivia, `/pickup-exception-rules/${first.id}`, { ladder: [products.fee], windowDays: 180 })).status, 200, "a kept step keeps its product")
        assert.equal((await refused(await patch(olivia, `/pickup-exception-rules/${first.id}`, { ladder: [products.fee, products.fee] }), 409)).detail, unofferedStep(2, "inactive"), "repeated, it is a new step")
        assert.equal((await refused(await patch(olivia, `/pickup-exception-rules/${first.id}`, { ladder: [products.warning, products.fee] }), 409)).detail, unofferedStep(2, "inactive"), "moved, it is a new step")
      } finally {
        await withCompany(pool.db, a.companyId, async (tx: Tx) => tx.update(product).set({ status: "active" }).where(eq(product.id, products.fee)))
      }
      assert.deepEqual(PickupExceptionRule.parse(await (await olivia(`/pickup-exception-rules/${first.id}`)).json()).ladder, [products.fee])
      assert.match((await refused(await patch(olivia, `/pickup-exception-rules/${first.id}`, { validTo: null }), 409)).detail ?? "", /already in force/, "reopened, it meets the next one")
      assert.deepEqual((await refused(await patch(olivia, `/pickup-exception-rules/${first.id}`, { validTo: "2026-12-01" }), 400)).errors?.map((error) => error.path), ["validTo"])
      assert.ok((await refused(await patch(olivia, `/pickup-exception-rules/${first.id}`, { reason: "other" }), 400)).errors?.some((error) => error.path === "reason"), "the key does not move")

      const inForce = RulePage.parse(await (await olivia(`/pickup-exception-rules?projectId=${a.projects.copenhagen.id}&validOn=2027-08-01&limit=200`)).json()).items.map((item) => item.id)
      assert.ok(inForce.includes(next.id) && !inForce.includes(first.id))
      await refused(await other(`/pickup-exception-rules/${first.id}`), 404)
      assert.match((await refused(await ungranted("/pickup-exception-rules"), 403)).detail ?? "", /view on commercial\.price-rows/)
    })
  })

  describe("the correction's tag and a place's history", () => {
    const correct = (pickupId: string, body: Record<string, unknown>) => post(olivia, `/pickups/${pickupId}/correct-outcome`, body)
    /** A completed route on a service date, its one stop at Parkvej failed for contamination, recorded by the driver. */
    const missedAtParkvej = async (day: string): Promise<SeededRoute> =>
      await seedRoute(pool, a, fleet, ex, {
        status: "completed",
        operatingDate: day,
        pickups: [{ containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, status: "failed", reason: "contamination", arrivedAt: at(day, "07:00"), outcomeAt: at(day, "07:05") }],
        proofs: [{ kind: "failure", pickupIndex: 0, occurredAt: at(day, "07:05"), reason: "contamination", location: TOWN_HALL }],
      })

    test("tags a stop missed for contamination, or collected all the same, with a code of the company for its fraction, active where it is new, and untags with null", async () => {
      // A year before the history below, outside its rules' window, so the two tests count apart.
      const route = await missedAtParkvej("2025-06-02")
      const [stop] = route.pickupIds
      const plastic = await newCode()
      const tagged = PickupDetail.parse(await (await correct(stop, { outcome: "failed", reason: "contamination", note: "Plastic bags in the residual bin", contaminantCodeId: plastic.id })).json())
      assert.equal(tagged.contaminantCodeId, plastic.id)
      assert.deepEqual([tagged.proofs.at(-1)?.kind, tagged.proofs.at(-1)?.contaminantCodeId], ["correction", plastic.id], "the correction proof says who tagged it and when")

      const glassOnly = await newCode({ wasteFractionIds: [ex.fractions.glass.id] })
      assert.deepEqual((await refused(await correct(stop, { outcome: "failed", reason: "contamination", note: "x", contaminantCodeId: glassOnly.id }), 400)).errors, [{ path: "contaminantCodeId", message: CODE_NOT_FOR_FRACTION }])
      assert.deepEqual((await refused(await correct(stop, { outcome: "failed", reason: "contamination", note: "x", contaminantCodeId: testId() }), 400)).errors, [{ path: "contaminantCodeId", message: NOT_A_CODE }])
      assert.deepEqual((await refused(await correct(stop, { outcome: "failed", reason: "inaccessible", note: "x", contaminantCodeId: plastic.id }), 400)).errors, [{ path: "contaminantCodeId", message: CODE_WITH_CONTAMINATION }])

      // Retired since: the stop keeps it, and no other stop takes it.
      await patch(olivia, `/contaminant-codes/${plastic.id}`, { status: "inactive" })
      assert.equal((await correct(stop, { outcome: "completed", note: "Emptied after all, plastic in it", contaminantCodeId: plastic.id })).status, 200, "a stop keeps the code it was tagged with")
      const another = (await missedAtParkvej("2025-06-03")).pickupIds[0]
      assert.equal((await refused(await correct(another, { outcome: "failed", reason: "contamination", note: "x", contaminantCodeId: plastic.id }), 409)).detail, retiredCode(plastic.code, "a tag"))
      // Narrowed since to glass: the stop keeps its own code all the same.
      await put(olivia, `/contaminant-codes/${plastic.id}/fractions`, { wasteFractionIds: [ex.fractions.glass.id] })
      assert.equal((await correct(stop, { outcome: "completed", note: "Still plastic in it", contaminantCodeId: plastic.id })).status, 200, "a stop keeps its code, narrowed since or not")
      const noted = PickupDetail.parse(await (await correct(stop, { outcome: "completed", note: "The crew's note, corrected" })).json())
      assert.equal(noted.contaminantCodeId, plastic.id, "a correction that never mentions the code leaves it")
      const unreached = PickupDetail.parse(await (await correct(stop, { outcome: "failed", reason: "inaccessible", note: "The gate was locked after all" })).json())
      assert.equal(unreached.contaminantCodeId, null, "an outcome that takes no code drops it")
      await correct(stop, { outcome: "failed", reason: "contamination", note: "Plastic after all", contaminantCodeId: plastic.id })
      const untagged = PickupDetail.parse(await (await correct(stop, { outcome: "completed", note: "No contamination after all", contaminantCodeId: null })).json())
      assert.equal(untagged.contaminantCodeId, null, "null untags")
    })

    test("lists a property's exceptions newest first with their evidence, judged by the rule in force: the first free, then the ladder, the last step repeating; `from` cuts the list and never the count", async () => {
      const plastic = await newCode()
      await created(
        olivia,
        "/pickup-exception-rules",
        await post(olivia, "/pickup-exception-rules", { projectId: a.projects.copenhagen.id, outcome: "failed", reason: "contamination", freeCount: 1, windowDays: 365, ladder: [products.warning, products.fee], validFrom: "2026-01-01", validTo: "2026-12-31" }),
        PickupExceptionRule,
      )
      const days = ["2026-09-01", "2026-09-15", "2026-09-29", "2026-10-05"]
      const routes: SeededRoute[] = []
      for (const day of days) routes.push(await missedAtParkvej(day))
      // The third's driver recorded on a phone running ten minutes fast: its proof's id sorts after anything the office writes now.
      await withCompany(pool.db, a.companyId, async (tx: Tx) =>
        tx.insert(proofOfService).values({
          id: testId(Date.now() + 10 * 60_000),
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          routeId: routes[2].id,
          pickupId: routes[2].pickupIds[0],
          sessionId: routes[2].sessionId,
          kind: "failure",
          source: "driver-app",
          occurredAt: at("2026-09-29", "07:06"),
          recordedBy: ex.logins.mads.id,
          deviceId: "device-mads-1",
          reason: "contamination",
        }),
      )
      // The office tags the third; its correction, recorded last on the server's clock, is then its evidence.
      const corrected = PickupDetail.parse(await (await correct(routes[2].pickupIds[0], { outcome: "failed", reason: "contamination", note: "Garden waste in the residual bin", contaminantCodeId: plastic.id })).json())

      const history = async (query = "?from=2026-09-01") => {
        const response = await olivia(`/properties/${ex.properties.parkvej.id}/pickup-exceptions${query}`)
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
        return PickupExceptionHistory.parse(await response.json())
      }
      const read = await history()
      const ours = read.items.filter((item) => routes.some((route) => route.pickupIds[0] === item.pickupId))
      assert.deepEqual(
        ours.map((item) => [item.serviceDate, item.judgement?.index, item.judgement?.free, item.judgement?.productId]),
        [
          ["2026-10-05", 3, false, products.fee],
          ["2026-09-29", 2, false, products.fee],
          ["2026-09-15", 1, false, products.warning],
          ["2026-09-01", 0, true, null],
        ],
        "newest first; the first free, then the ladder, its last step repeating",
      )
      const correction = corrected.proofs.find((proof) => proof.kind === "correction")
      assert.ok(correction !== undefined && corrected.proofs.at(-1)?.id !== correction.id, "the device's proof sorts last by id")
      assert.equal(ours[1].evidenceProofId, correction.id, "the office's correction is the latest outcome proof on the server's clock")
      assert.equal(ours[1].contaminantCodeId, plastic.id)
      assert.equal(read.truncated, false)

      const later = (await history("?from=2026-09-20")).items.filter((item) => routes.some((route) => route.pickupIds[0] === item.pickupId))
      assert.deepEqual(
        later.map((item) => [item.serviceDate, item.judgement?.index]),
        [
          ["2026-10-05", 3],
          ["2026-09-29", 2],
        ],
        "an earlier exception is counted though it is not listed",
      )
      assert.ok(!read.items.some((item) => item.pickupId === ex.routes.completed.pickupIds[0]), "a plain collection is no exception")
    })

    test("a shared collection point is a history of its own, and either read is the family's 404 elsewhere and a 403 without both grants", async () => {
      const point = await olivia(`/shared-collection-points/${testId()}/pickup-exceptions`)
      await refused(point, 404)
      await refused(await other(`/properties/${ex.properties.parkvej.id}/pickup-exceptions`), 404)
      assert.match((await refused(await ungranted(`/properties/${ex.properties.parkvej.id}/pickup-exceptions`), 403)).detail ?? "", /customers\.properties/)
    })
  })
})
