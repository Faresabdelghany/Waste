// Settings › Account & appearance on the Pilot (#282): the person signed in,
// as `/me` answered, never the fixture persona.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Me } from "@waste/contracts/me"

import { initialsOf, profileOf } from "../account-profile"

const COMPANY = { id: "01a0d2a4-a280-7001-8000-000000000001", name: "Kystbyen Renovation" }
const ROLE = { id: "01a0d2a4-a280-7004-8000-000000000001", key: "company-administrator", name: "Company Administrator", scope: "Company", system: true, grants: [] }
const PROJECTS = [
  { id: "01a0d2a4-a280-7002-8000-000000000003", name: "Cairo Operations" },
  { id: "01a0d2a4-a280-7002-8000-000000000001", name: "Copenhagen Central" },
  { id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial" },
]

const fares: Me = {
  user: { id: "01a0d2a4-a280-7003-8000-000000000001", email: "fares.abdelghany@kystbyen.example", fullName: "Fares Abdelghany", status: "active", allProjects: true, primaryAdministrator: true },
  company: COMPANY,
  role: ROLE,
  projects: PROJECTS,
  serviceProvider: null,
  driver: null,
}
const mads: Me = {
  ...fares,
  user: { ...fares.user, id: "01a0d2a4-a280-7003-8000-000000000002", email: "mads.jensen@kystbyen.example", fullName: "Mads Jensen", allProjects: false, primaryAdministrator: false },
  role: { ...ROLE, key: "driver", name: "Driver" },
  projects: [PROJECTS[1]],
  driver: { id: "01a0d2a4-a280-7027-8000-000000000001" },
}
const lars: Me = {
  ...mads,
  user: { ...mads.user, id: "01a0d2a4-a280-7003-8000-000000000003", email: "lars.mikkelsen@nordren.example", fullName: "Lars Mikkelsen" },
  role: { ...ROLE, key: "service-provider-manager", name: "Service Provider Manager" },
  projects: [],
  serviceProvider: { id: "01a0d2a4-a280-7020-8000-000000000001", legalName: "NordRen ApS" },
  driver: null,
}

describe("the account pane's profile on the Pilot (#282)", () => {
  test("is the person /me answered: name, e-mail, role, and every project for one who works in all of them", () => {
    assert.deepEqual(profileOf(fares, fares.user.email), {
      name: "Fares Abdelghany",
      email: "fares.abdelghany@kystbyen.example",
      role: "Company Administrator · Primary administrator",
      projects: "All projects: Cairo Operations, Copenhagen Central, Harbor Commercial",
      initials: "FA",
    })
  })

  test("names the projects an account works in, and a provider's account by its provider, since it lists none", () => {
    assert.equal(profileOf(mads, undefined).projects, "Copenhagen Central")
    assert.equal(profileOf(mads, undefined).role, "Driver")
    assert.equal(profileOf(lars, undefined).projects, "Through NordRen ApS's service areas")
  })

  test("before /me has answered, stands in the e-mail Auth gave at sign-in and says the rest is being read", () => {
    assert.deepEqual(profileOf(null, "fares.abdelghany@kystbyen.example"), {
      name: "fares.abdelghany@kystbyen.example",
      email: "fares.abdelghany@kystbyen.example",
      role: "Reading your account…",
      projects: "Reading your account…",
      initials: "F",
    })
    assert.equal(profileOf(null, undefined).name, "")
  })

  test("initials are the first and last names' first letters, one letter for a single word", () => {
    assert.deepEqual(["Fares Abdelghany", "Mads Peter Jensen", "Olivia", "  ", "ålborg kommune"].map(initialsOf), ["FA", "MJ", "O", "", "ÅK"])
  })
})
