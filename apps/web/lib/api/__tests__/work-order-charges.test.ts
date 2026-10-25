import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WorkOrderChargesSet, type WorkOrderCharges } from "@waste/contracts/work-order-charges"

import { ApiProblem } from "../problem"
import { readWorkOrderCharges, replaceWorkOrderCharges } from "../work-order-charges"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const PROJECT = "01a0d2a4-a280-7001-8000-000000000001"
const DELIVERY = "01a0d2a4-a280-700a-8000-000000000011"

describe("a project's work order charges through the client (M14 of #293)", () => {
  const set: WorkOrderCharges = { projectId: PROJECT, charges: [{ service: "deliver", productId: DELIVERY }] }

  test("reads the project's set and replaces it whole, the answer being the set as it now stands", async () => {
    const { fetch, calls } = scripted([() => json(set), () => json(set)])
    assert.deepEqual(await readWorkOrderCharges(clientOver(fetch), PROJECT), set)
    assert.equal(calls[0].url, `http://api.test/work-order-charges?projectId=${PROJECT}`)
    assert.deepEqual(await replaceWorkOrderCharges(clientOver(fetch), set), set)
    assert.equal(calls[1].url, "http://api.test/work-order-charges")
    assert.equal(calls[1].init.method, "PUT")
    assert.ok(WorkOrderChargesSet.safeParse(bodyOf(calls[1])).success)
  })

  test("hands the API's refusal back as its problem: a product not sold by the job is the 400 at its pick", async () => {
    const { fetch } = scripted([() => problem(400, "A work order's job is charged at a product sold by the job")])
    await assert.rejects(replaceWorkOrderCharges(clientOver(fetch), set), (error: unknown) => error instanceof ApiProblem && error.problem.status === 400)
  })
})
