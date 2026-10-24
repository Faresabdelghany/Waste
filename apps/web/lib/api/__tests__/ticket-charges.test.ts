import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TicketChargesSet, type TicketCharges } from "@waste/contracts/tickets"

import { ApiProblem } from "../problem"
import { readTicketCharges, replaceTicketCharges } from "../ticket-charges"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const PROJECT = "01a0d2a4-a280-7001-8000-000000000001"
const BULKY = "01a0d2a4-a280-700a-8000-000000000005"

describe("a project's ticket charges through the client (#291 C3)", () => {
  const set: TicketCharges = { projectId: PROJECT, charges: [{ kind: "overflow", productId: BULKY }] }

  test("reads the project's set and replaces it whole, the answer being the set as it now stands", async () => {
    const { fetch, calls } = scripted([() => json(set), () => json(set)])
    assert.deepEqual(await readTicketCharges(clientOver(fetch), PROJECT), set)
    assert.equal(calls[0].url, `http://api.test/ticket-charges?projectId=${PROJECT}`)
    assert.deepEqual(await replaceTicketCharges(clientOver(fetch), set), set)
    assert.equal(calls[1].url, "http://api.test/ticket-charges")
    assert.equal(calls[1].init.method, "PUT")
    assert.ok(TicketChargesSet.safeParse(bodyOf(calls[1])).success)
  })

  test("hands the API's refusal back as its problem: a retired product's 409 in the API's words", async () => {
    const { fetch } = scripted([() => problem(409, "The product is inactive; only an active product can be subscribed to")])
    await assert.rejects(replaceTicketCharges(clientOver(fetch), set), (error: unknown) => error instanceof ApiProblem && error.problem.status === 409)
  })
})
