import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PRODUCT_KINDS, PRODUCT_STATUSES, PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"

import {
  ContainerType,
  ContainerTypeCreate,
  ContainerTypePatch,
  Product,
  ProductCreate,
  ProductKind,
  ProductPatch,
  ProductStatus,
  ProductUnit,
  ServiceFrequency,
  ServiceFrequencyCreate,
  ServiceFrequencyPatch,
  serviceFrequencyShape,
  WasteFraction,
  WasteFractionCreate,
  WasteFractionPatch,
} from "../catalogue"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }

/** Each issue a failed parse produced, as the API's 400 would spell it. */
const refusal = (result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }) => {
  assert.equal(result.success, false)
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }))
}

/** A create body says nothing the server owns; the strict object refuses each one by name. */
const refusesWhatTheServerOwns = (schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } }, body: object) => {
  for (const [key, value] of [["id", ID], ["createdAt", STAMPS.createdAt], ["updatedAt", STAMPS.updatedAt]] as const) {
    const issues = refusal(schema.safeParse({ ...body, [key]: value }))
    assert.deepEqual(issues.map((issue) => issue.path), [""], key)
    assert.match(issues[0].message, new RegExp(key))
  }
}

/** A patch with nothing in it is a client bug, not a no-op. */
const refusesAnEmptyPatch = (schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } }) => {
  assert.deepEqual(refusal(schema.safeParse({})), [{ path: "", message: "Give at least one field to change" }])
}

const fraction = { id: ID, key: "hard-plastic", name: "Hard plastic", ...STAMPS }
const containerType = { id: ID, name: "240 L two-wheeled", volumeLitres: 240, ...STAMPS }
const frequency = {
  id: ID,
  projectId: OTHER,
  name: "Every other week",
  description: "Collected on the even weeks of the calendar.",
  collectionsPerWeek: 1,
  weeksBetween: 2,
  daysBetween: null,
  ...STAMPS,
}
const product = {
  id: ID,
  projectId: OTHER,
  name: "Residual waste, 240 L",
  kind: "container-collection",
  status: "active",
  unit: "pickup",
  containerTypeId: OTHER,
  wasteFractionId: OTHER,
  serviceFrequencyId: OTHER,
  ...STAMPS,
}

describe("the catalogue enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(ProductKind.options, [...PRODUCT_KINDS])
    assert.deepEqual(ProductStatus.options, [...PRODUCT_STATUSES])
    assert.deepEqual(ProductUnit.options, [...PRODUCT_UNITS])
    assert.equal(ProductKind.safeParse("container-rental").success, false)
    assert.equal(ProductStatus.safeParse("Draft").success, false)
  })
})

describe("WasteFraction", () => {
  test("is the row on the wire: the slug the system quotes and the name a person reads", () => {
    assert.deepEqual(WasteFraction.parse(fraction), fraction)
  })

  test("holds the key to a lowercase slug, so two rows cannot differ by case or spacing alone", () => {
    for (const key of ["residual", "food", "glass2", "hard-plastic", "wood-and-branches"]) {
      assert.equal(WasteFraction.parse({ ...fraction, key }).key, key, key)
    }
    for (const key of ["Residual", "hard plastic", "hard_plastic", "-food", "food-", "food--waste", "", "x".repeat(51)]) {
      assert.equal(WasteFraction.safeParse({ ...fraction, key }).success, false, JSON.stringify(key))
    }
  })
})

describe("WasteFractionCreate and WasteFractionPatch", () => {
  test("take the key and the name, and mint nothing", () => {
    assert.deepEqual(WasteFractionCreate.parse({ key: "food", name: "Food waste" }), { key: "food", name: "Food waste" })
    refusesWhatTheServerOwns(WasteFractionCreate, { key: "food", name: "Food waste" })
    for (const key of ["key", "name"]) {
      const body: Record<string, unknown> = { key: "food", name: "Food waste" }
      delete body[key]
      assert.deepEqual(refusal(WasteFractionCreate.safeParse(body)).map((issue) => issue.path), [key])
    }
  })

  test("change one field or both, and refuse an empty patch", () => {
    assert.deepEqual(WasteFractionPatch.parse({ name: "Food" }), { name: "Food" })
    assert.deepEqual(WasteFractionPatch.parse({ key: "food", name: "Food" }), { key: "food", name: "Food" })
    refusesAnEmptyPatch(WasteFractionPatch)
    assert.equal(WasteFractionPatch.safeParse({ key: "Food" }).success, false)
  })
})

describe("ContainerType", () => {
  test("is the row on the wire, the volume null where nobody recorded one", () => {
    assert.deepEqual(ContainerType.parse(containerType), containerType)
    assert.deepEqual(ContainerType.parse({ ...containerType, volumeLitres: null }), { ...containerType, volumeLitres: null })
  })

  test("takes whole positive litres and nothing else: zero is not a volume", () => {
    for (const volumeLitres of [0, -240, 240.5, "240"]) {
      assert.equal(ContainerType.safeParse({ ...containerType, volumeLitres }).success, false, JSON.stringify(volumeLitres))
    }
  })
})

describe("ContainerTypeCreate and ContainerTypePatch", () => {
  test("take the name, leave the volume out for null, and mint nothing", () => {
    assert.deepEqual(ContainerTypeCreate.parse({ name: "660 L four-wheeled" }), { name: "660 L four-wheeled" })
    assert.deepEqual(ContainerTypeCreate.parse({ name: "660 L", volumeLitres: null }), { name: "660 L", volumeLitres: null })
    refusesWhatTheServerOwns(ContainerTypeCreate, { name: "660 L four-wheeled" })
    assert.deepEqual(refusal(ContainerTypeCreate.safeParse({ volumeLitres: 660 })).map((issue) => issue.path), ["name"])
  })

  test("clear the volume with null, and refuse an empty patch", () => {
    assert.deepEqual(ContainerTypePatch.parse({ volumeLitres: null }), { volumeLitres: null })
    refusesAnEmptyPatch(ContainerTypePatch)
  })
})

describe("serviceFrequencyShape", () => {
  test("takes on demand, a rate on its own, and a rate with one interval", () => {
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: null, weeksBetween: null, daysBetween: null }), true)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 1, weeksBetween: null, daysBetween: null }), true)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 1, weeksBetween: 2, daysBetween: null }), true)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 3, weeksBetween: null, daysBetween: 2 }), true)
  })

  test("refuses an interval with no rate to belong to, and the two intervals at once", () => {
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: null, weeksBetween: 2, daysBetween: null }), false)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: null, weeksBetween: null, daysBetween: 2 }), false)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 1, weeksBetween: 2, daysBetween: 3 }), false)
  })

  test("says nothing about a rate it was not given, which is what a patch that leaves it alone gives", () => {
    assert.equal(serviceFrequencyShape({ weeksBetween: 2 }), true)
    assert.equal(serviceFrequencyShape({ daysBetween: 2 }), true)
    assert.equal(serviceFrequencyShape({ weeksBetween: 2, daysBetween: 3 }), false)
  })
})

describe("ServiceFrequency", () => {
  test("is the definition on the wire: a rate, at most one interval, and the project it belongs to", () => {
    assert.deepEqual(ServiceFrequency.parse(frequency), frequency)
    const onDemand = { ...frequency, description: null, collectionsPerWeek: null, weeksBetween: null, daysBetween: null }
    assert.deepEqual(ServiceFrequency.parse(onDemand), onDemand)
  })

  test("holds the shape rule: no interval without a rate, and never both intervals", () => {
    assert.equal(ServiceFrequency.safeParse({ ...frequency, collectionsPerWeek: null }).success, false)
    assert.equal(ServiceFrequency.safeParse({ ...frequency, daysBetween: 3 }).success, false)
    assert.equal(ServiceFrequency.safeParse({ ...frequency, weeksBetween: 0 }).success, false)
  })
})

describe("ServiceFrequencyCreate and ServiceFrequencyPatch", () => {
  const body = { projectId: OTHER, name: "Weekly", collectionsPerWeek: 1 }

  test("take the project and the name, read an absent rate as on demand, and mint nothing", () => {
    assert.deepEqual(ServiceFrequencyCreate.parse(body), body)
    assert.deepEqual(ServiceFrequencyCreate.parse({ projectId: OTHER, name: "On demand" }), { projectId: OTHER, name: "On demand" })
    refusesWhatTheServerOwns(ServiceFrequencyCreate, body)
    for (const key of ["projectId", "name"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(ServiceFrequencyCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("refuse a create whose interval has no rate, an absent rate being the null the row will hold", () => {
    assert.deepEqual(refusal(ServiceFrequencyCreate.safeParse({ projectId: OTHER, name: "Fortnightly", weeksBetween: 2 })), [
      { path: "", message: "Give collectionsPerWeek with at most one of weeksBetween and daysBetween, or none of the three (on demand)" },
    ])
    assert.equal(ServiceFrequencyCreate.safeParse({ ...body, weeksBetween: 2, daysBetween: 3 }).success, false)
  })

  test("patch the fields given, refuse an empty patch, and never take the project", () => {
    assert.deepEqual(ServiceFrequencyPatch.parse({ weeksBetween: 2 }), { weeksBetween: 2 })
    assert.deepEqual(ServiceFrequencyPatch.parse({ description: null }), { description: null })
    refusesAnEmptyPatch(ServiceFrequencyPatch)
    assert.equal(ServiceFrequencyPatch.safeParse({ weeksBetween: 2, daysBetween: 3 }).success, false)
    assert.match(refusal(ServiceFrequencyPatch.safeParse({ name: "Weekly", projectId: OTHER }))[0].message, /projectId/)
  })
})

describe("Product", () => {
  test("is the row on the wire: what it delivers, in which unit, and the three optional references", () => {
    assert.deepEqual(Product.parse(product), product)
    const service = { ...product, kind: "recurring-service", unit: "month", containerTypeId: null, wasteFractionId: null, serviceFrequencyId: null }
    assert.deepEqual(Product.parse(service), service)
  })

  test("refuses a kind, a status or a unit the vocabulary does not have", () => {
    assert.equal(Product.safeParse({ ...product, kind: "rental" }).success, false)
    assert.equal(Product.safeParse({ ...product, status: "retired" }).success, false)
    assert.equal(Product.safeParse({ ...product, unit: "litre" }).success, false)
  })
})

describe("ProductCreate and ProductPatch", () => {
  const body = { projectId: OTHER, name: "Residual waste, 240 L", kind: "container-collection", unit: "pickup" }

  test("default the status to draft, and say so in the schema", () => {
    assert.deepEqual(ProductCreate.parse(body), { ...body, status: "draft" })
    assert.equal(ProductCreate.parse({ ...body, status: "active" }).status, "active")
    assert.match(ProductCreate.shape.status.description ?? "", /draft/)
  })

  test("need the project, the name, the kind and the unit, and mint nothing", () => {
    for (const key of ["projectId", "name", "kind", "unit"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(ProductCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(ProductCreate, body)
  })

  test("clear a reference with null, refuse an empty patch, and never take the project", () => {
    assert.deepEqual(ProductPatch.parse({ serviceFrequencyId: null }), { serviceFrequencyId: null })
    assert.deepEqual(ProductPatch.parse({ status: "inactive" }), { status: "inactive" })
    refusesAnEmptyPatch(ProductPatch)
    assert.match(refusal(ProductPatch.safeParse({ name: "x", projectId: OTHER }))[0].message, /projectId/)
  })
})
