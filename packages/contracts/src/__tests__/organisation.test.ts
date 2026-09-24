import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  Company,
  CompanyPatch,
  CompanyStatus,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectStatus,
  ServiceProvider,
  ServiceProviderCreate,
  ServiceProviderPatch,
} from "../organisation"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }

const company = {
  id: ID,
  name: "WasteHero Denmark",
  legalName: "WasteHero Denmark A/S",
  registrationNumber: "38144209",
  country: "DK",
  status: "active",
  ...STAMPS,
}

const project = {
  id: ID,
  name: "Copenhagen Central",
  kind: "Municipality",
  language: "da",
  currency: "DKK",
  timezone: "Europe/Copenhagen",
  status: "onboarding",
  ...STAMPS,
}

const provider = {
  id: ID,
  legalName: "NordRen ApS",
  registrationNumber: "38144210",
  country: "DK",
  contactName: "Lars Mikkelsen",
  contactEmail: "lars.mikkelsen@nordren.dk",
  ...STAMPS,
}

/** The one issue a failed parse produced, as the API's 400 would spell it. */
const refusal = (result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }) => {
  assert.equal(result.success, false)
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }))
}

describe("the statuses", () => {
  test("are the two the database's check allows, in the same order (packages/db holds them in lockstep)", () => {
    assert.deepEqual(CompanyStatus.options, ["active", "onboarding"])
    assert.deepEqual(ProjectStatus.options, ["active", "onboarding"])
    assert.equal(CompanyStatus.safeParse("archived").success, false)
    assert.equal(CompanyStatus.safeParse("Active").success, false)
  })
})

describe("Company", () => {
  test("is the row on the wire: a version 7 id, the registry's identity, and instants as RFC 3339", () => {
    assert.deepEqual(Company.parse(company), company)
  })

  test("lowercases the id and refuses one of another version, a bad instant and an unknown status", () => {
    assert.equal(Company.parse({ ...company, id: ID.toUpperCase() }).id, ID)
    assert.equal(Company.safeParse({ ...company, id: "01a0d3a5-e5e0-4000-8000-000000000001" }).success, false)
    assert.equal(Company.safeParse({ ...company, createdAt: "2026-09-24" }).success, false)
    assert.equal(Company.safeParse({ ...company, createdAt: "2026-09-24T13:41:00" }).success, false)
    assert.equal(Company.safeParse({ ...company, status: "paused" }).success, false)
  })

  test("needs every member: nothing here is optional", () => {
    for (const key of Object.keys(company)) {
      const { [key]: _dropped, ...without } = company as Record<string, unknown>
      assert.equal(Company.safeParse(without).success, false, key)
    }
  })

  test("takes the country as ISO 3166-1 alpha-2, uppercase and nothing else", () => {
    assert.equal(Company.parse({ ...company, country: "EG" }).country, "EG")
    for (const country of ["dk", "Dk", "DNK", "D", "DK ", "", "12"]) {
      assert.equal(Company.safeParse({ ...company, country }).success, false, JSON.stringify(country))
    }
  })
})

describe("CompanyPatch", () => {
  test("changes what an administrator may change, one field or several", () => {
    assert.deepEqual(CompanyPatch.parse({ name: "WasteHero DK" }), { name: "WasteHero DK" })
    assert.deepEqual(CompanyPatch.parse({ legalName: "WasteHero DK A/S", registrationNumber: "12345678", country: "SE" }), {
      legalName: "WasteHero DK A/S",
      registrationNumber: "12345678",
      country: "SE",
    })
  })

  test("refuses an empty patch: a change with nothing to change is a mistake, not a no-op", () => {
    assert.deepEqual(refusal(CompanyPatch.safeParse({})), [{ path: "", message: "Give at least one field to change" }])
  })

  test("refuses a member it does not own, the status included: onboarding to active is an operator's act", () => {
    assert.match(refusal(CompanyPatch.safeParse({ name: "x", status: "active" }))[0].message, /status/)
    assert.match(refusal(CompanyPatch.safeParse({ name: "x", id: ID }))[0].message, /id/)
    assert.match(refusal(CompanyPatch.safeParse({ name: "x", createdAt: STAMPS.createdAt }))[0].message, /createdAt/)
  })

  test("holds each field to the shape Company gives it", () => {
    assert.equal(CompanyPatch.safeParse({ name: "" }).success, false)
    assert.equal(CompanyPatch.safeParse({ country: "denmark" }).success, false)
    assert.equal(CompanyPatch.safeParse({ registrationNumber: "" }).success, false)
  })
})

describe("Project", () => {
  test("is the row on the wire, kind free text and the rest by shape", () => {
    assert.deepEqual(Project.parse(project), project)
  })

  test("takes a BCP 47 language by shape", () => {
    for (const language of ["da", "en", "ar", "en-GB", "zh-Hans-CN", "de-DE-1996"]) {
      assert.equal(Project.parse({ ...project, language }).language, language, language)
    }
    for (const language of ["", "d", "DA", "da_DK", "danish-", "en-", "en-GB-"]) {
      assert.equal(Project.safeParse({ ...project, language }).success, false, JSON.stringify(language))
    }
  })

  test("takes an ISO 4217 currency, three uppercase letters", () => {
    for (const currency of ["DKK", "EUR", "EGP"]) assert.equal(Project.parse({ ...project, currency }).currency, currency)
    for (const currency of ["dkk", "DK", "DKKK", "", "D1K"]) {
      assert.equal(Project.safeParse({ ...project, currency }).success, false, JSON.stringify(currency))
    }
  })

  test("takes an IANA timezone by shape: Area/Location, or UTC", () => {
    for (const timezone of ["Europe/Copenhagen", "Africa/Cairo", "America/Argentina/Buenos_Aires", "America/Port-au-Prince", "Etc/GMT+2", "UTC"]) {
      assert.equal(Project.parse({ ...project, timezone }).timezone, timezone, timezone)
    }
    for (const timezone of ["", "Copenhagen", "Europe/", "/Copenhagen", "Europe/Copenhagen/", "Europe Copenhagen", "+02:00", "utc"]) {
      assert.equal(Project.safeParse({ ...project, timezone }).success, false, JSON.stringify(timezone))
    }
  })
})

describe("ProjectCreate", () => {
  test("takes what a project needs and mints nothing: the server owns the id and the timestamps", () => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...body } = project
    assert.deepEqual(ProjectCreate.parse(body), body)
    assert.match(refusal(ProjectCreate.safeParse({ ...body, id: ID }))[0].message, /id/)
    assert.match(refusal(ProjectCreate.safeParse({ ...body, createdAt: STAMPS.createdAt }))[0].message, /createdAt/)
  })

  test("defaults the status to onboarding, and says so in the schema", () => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, status: _status, ...body } = project
    assert.equal(ProjectCreate.parse(body).status, "onboarding")
    assert.equal(ProjectCreate.parse({ ...body, status: "active" }).status, "active")
    assert.match(ProjectCreate.shape.status.description ?? "", /onboarding/)
  })

  test("needs a name, a kind, a language, a currency and a timezone", () => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...body } = project
    for (const key of ["name", "kind", "language", "currency", "timezone"]) {
      const { [key]: _dropped, ...without } = body as Record<string, unknown>
      assert.deepEqual(refusal(ProjectCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.equal(ProjectCreate.safeParse({ ...body, name: "" }).success, false)
  })
})

describe("ProjectPatch", () => {
  test("changes any of the six, and refuses an empty patch or a member it does not own", () => {
    assert.deepEqual(ProjectPatch.parse({ status: "active" }), { status: "active" })
    assert.deepEqual(ProjectPatch.parse({ name: "Harbor", kind: "Contract", language: "en-GB", currency: "EUR", timezone: "UTC", status: "onboarding" }), {
      name: "Harbor",
      kind: "Contract",
      language: "en-GB",
      currency: "EUR",
      timezone: "UTC",
      status: "onboarding",
    })
    assert.deepEqual(refusal(ProjectPatch.safeParse({})), [{ path: "", message: "Give at least one field to change" }])
    assert.match(refusal(ProjectPatch.safeParse({ name: "x", id: ID }))[0].message, /id/)
    assert.equal(ProjectPatch.safeParse({ timezone: "Copenhagen" }).success, false)
  })
})

describe("ServiceProvider", () => {
  test("is the external organisation and the person to call at it", () => {
    assert.deepEqual(ServiceProvider.parse(provider), provider)
    assert.equal(ServiceProvider.safeParse({ ...provider, contactEmail: "lars" }).success, false)
    assert.equal(ServiceProvider.safeParse({ ...provider, country: "dk" }).success, false)
  })

  test("needs every member: a provider without a contact is a provider nobody can call", () => {
    for (const key of Object.keys(provider)) {
      const { [key]: _dropped, ...without } = provider as Record<string, unknown>
      assert.equal(ServiceProvider.safeParse(without).success, false, key)
    }
  })
})

describe("ServiceProviderCreate", () => {
  test("requires the contact too: both columns are NOT NULL", () => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...body } = provider
    assert.deepEqual(ServiceProviderCreate.parse(body), body)
    for (const key of ["legalName", "registrationNumber", "country", "contactName", "contactEmail"]) {
      const { [key]: _dropped, ...without } = body as Record<string, unknown>
      assert.deepEqual(refusal(ServiceProviderCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.match(refusal(ServiceProviderCreate.safeParse({ ...body, id: ID }))[0].message, /id/)
  })
})

describe("ServiceProviderPatch", () => {
  test("changes any of the five, and refuses an empty patch", () => {
    assert.deepEqual(ServiceProviderPatch.parse({ contactEmail: "mikkel@nordren.dk" }), { contactEmail: "mikkel@nordren.dk" })
    assert.deepEqual(refusal(ServiceProviderPatch.safeParse({})), [{ path: "", message: "Give at least one field to change" }])
    assert.equal(ServiceProviderPatch.safeParse({ contactEmail: "nobody" }).success, false)
    assert.match(refusal(ServiceProviderPatch.safeParse({ legalName: "x", id: ID }))[0].message, /id/)
  })
})
