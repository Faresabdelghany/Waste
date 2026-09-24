import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CONTAINER_OWNERSHIPS } from "@waste/domain/registry/vocabulary"

import {
  Container,
  ContainerCreate,
  ContainerListQuery,
  ContainerOwnership,
  ContainerPatch,
  ContainerServicePlacement,
  ContainerServicePlacementCreate,
  ContainerServicePlacementPatch,
  PlacementListQuery,
} from "../containers"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const BACKWARDS = "validTo is the first day out of force, so it comes after validFrom"

const container = {
  id: ID,
  projectId: OTHER,
  label: "BIN-82014",
  containerTypeId: THIRD,
  barcode: "5701234567890",
  rfid: "E20034120138",
  serialNumber: "SN-4471",
  ownership: "company",
  notes: "Lid replaced in March.",
  ...STAMPS,
}

const placement = {
  id: ID,
  projectId: OTHER,
  containerId: THIRD,
  subscriptionId: THIRD,
  wasteFractionId: THIRD,
  serviceFrequencyId: null,
  effectiveServiceFrequencyId: THIRD,
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

describe("ContainerOwnership", () => {
  test("is the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(ContainerOwnership.options, [...CONTAINER_OWNERSHIPS])
    assert.equal(ContainerOwnership.safeParse("leased").success, false)
  })
})

describe("Container", () => {
  test("is the identity a person reads off the bin, and carries no status and no location", () => {
    assert.deepEqual(Container.parse(container), container)
    const bare = { ...container, barcode: null, rfid: null, serialNumber: null, notes: null, ownership: "unrecorded" }
    assert.deepEqual(Container.parse(bare), bare)
    for (const key of ["status", "location"]) assert.equal(Object.keys(Container.shape).includes(key), false, key)
  })

  test("needs a label and a type: a container nobody can name is a container nobody can find", () => {
    for (const key of ["label", "containerTypeId"]) {
      const without: Record<string, unknown> = { ...container }
      delete without[key]
      assert.equal(Container.safeParse(without).success, false, key)
    }
    assert.equal(Container.safeParse({ ...container, label: "  " }).success, false)
  })
})

describe("ContainerCreate and ContainerPatch", () => {
  const body = { projectId: OTHER, label: "BIN-82014", containerTypeId: THIRD }

  test("default the ownership to the company's, and say so in the schema", () => {
    assert.deepEqual(ContainerCreate.parse(body), { ...body, ownership: "company" })
    assert.equal(ContainerCreate.parse({ ...body, ownership: "customer" }).ownership, "customer")
    assert.match(ContainerCreate.shape.ownership.description ?? "", /company/)
  })

  test("need the project, the label and the type, and mint nothing", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(ContainerCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(ContainerCreate, body)
  })

  test("clear an identifier with null, refuse an empty patch, and never take the project", () => {
    assert.deepEqual(ContainerPatch.parse({ rfid: null }), { rfid: null })
    assert.deepEqual(ContainerPatch.parse({ containerTypeId: THIRD }), { containerTypeId: THIRD })
    refusesAnEmptyPatch(ContainerPatch)
    assert.match(refusal(ContainerPatch.safeParse({ label: "x", projectId: OTHER }))[0].message, /projectId/)
  })
})

describe("ContainerServicePlacement", () => {
  test("is the container in service: which subscription, which fraction, and the period it holds for", () => {
    assert.deepEqual(ContainerServicePlacement.parse(placement), placement)
    const overridden = { ...placement, serviceFrequencyId: OTHER, effectiveServiceFrequencyId: OTHER, validTo: "2027-01-01" }
    assert.deepEqual(ContainerServicePlacement.parse(overridden), overridden)
  })

  test("answers the effective frequency it read through the coalesce, which may be null when neither has one", () => {
    const neither = { ...placement, serviceFrequencyId: null, effectiveServiceFrequencyId: null }
    assert.deepEqual(ContainerServicePlacement.parse(neither), neither)
    assert.deepEqual(refusal(ContainerServicePlacement.safeParse({ ...placement, validTo: "2025-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })
})

describe("ContainerServicePlacementCreate", () => {
  const body = { subscriptionId: THIRD, wasteFractionId: THIRD, validFrom: "2026-01-01" }

  test("names the subscription, the fraction and the first day; the container is the path's and the project is its", () => {
    assert.deepEqual(ContainerServicePlacementCreate.parse(body), body)
    assert.deepEqual(ContainerServicePlacementCreate.parse({ ...body, serviceFrequencyId: OTHER, validTo: "2027-01-01" }), {
      ...body,
      serviceFrequencyId: OTHER,
      validTo: "2027-01-01",
    })
    for (const key of ["containerId", "projectId", "effectiveServiceFrequencyId"]) {
      assert.match(refusal(ContainerServicePlacementCreate.safeParse({ ...body, [key]: OTHER }))[0].message, new RegExp(key))
    }
  })

  test("needs all three, refuses a backwards period, and mints nothing", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(ContainerServicePlacementCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.deepEqual(refusal(ContainerServicePlacementCreate.safeParse({ ...body, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    refusesWhatTheServerOwns(ContainerServicePlacementCreate, body)
  })
})

describe("ContainerServicePlacementPatch", () => {
  test("ends the placement, corrects the fraction and overrides the frequency, and moves nothing else", () => {
    assert.deepEqual(ContainerServicePlacementPatch.parse({ validTo: "2026-07-01" }), { validTo: "2026-07-01" })
    assert.deepEqual(ContainerServicePlacementPatch.parse({ serviceFrequencyId: null }), { serviceFrequencyId: null })
    assert.deepEqual(ContainerServicePlacementPatch.parse({ wasteFractionId: THIRD }), { wasteFractionId: THIRD })
    refusesAnEmptyPatch(ContainerServicePlacementPatch)
    for (const key of ["validFrom", "subscriptionId", "containerId"]) {
      assert.match(refusal(ContainerServicePlacementPatch.safeParse({ validTo: null, [key]: "2026-01-01" }))[0].message, new RegExp(key))
    }
  })
})

describe("ContainerListQuery", () => {
  test("takes a page, the project and the type of container", () => {
    assert.deepEqual(ContainerListQuery.parse({}), { limit: 50 })
    assert.deepEqual(ContainerListQuery.parse({ projectId: OTHER, containerTypeId: THIRD }), { projectId: OTHER, containerTypeId: THIRD, limit: 50 })
    assert.equal(ContainerListQuery.safeParse({ containerTypeId: "all" }).success, false)
  })
})

describe("PlacementListQuery", () => {
  test("asks by container, by subscription or by place, on a page", () => {
    assert.deepEqual(PlacementListQuery.parse({ containerId: THIRD }), { containerId: THIRD, limit: 50 })
    assert.deepEqual(PlacementListQuery.parse({ projectId: OTHER, subscriptionId: THIRD, validOn: "2026-06-01" }), {
      projectId: OTHER,
      subscriptionId: THIRD,
      validOn: "2026-06-01",
      limit: 50,
    })
  })

  test("refuses a place without a day, because the containers at a property are the containers there on a day", () => {
    for (const place of ["propertyId", "sharedCollectionPointId"]) {
      assert.deepEqual(refusal(PlacementListQuery.safeParse({ [place]: THIRD })), [
        { path: "validOn", message: "Give validOn with propertyId or sharedCollectionPointId: what stands at a place is what stands there on a day" },
      ])
      assert.equal(PlacementListQuery.safeParse({ [place]: THIRD, validOn: "2026-06-01" }).success, true, place)
    }
  })
})
