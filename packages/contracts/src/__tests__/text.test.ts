import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { UserInvite } from "../access"
import { Me } from "../me"
import { ProjectCreate } from "../organisation"
import { Label, LABEL_MAX, Paragraph, PARAGRAPH_MAX } from "../text"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const longer = "n".repeat(LABEL_MAX + 1)

describe("Label", () => {
  test("takes the text a person typed, spaces and all, and stores it as it arrived", () => {
    assert.equal(Label.parse("Copenhagen Central"), "Copenhagen Central")
    assert.equal(Label.parse(" Copenhagen Central "), " Copenhagen Central ", "trimming would answer something the body did not say")
    assert.equal(Label.parse("n".repeat(LABEL_MAX)), "n".repeat(LABEL_MAX))
  })

  test("refuses the empty string, whitespace only, and anything past the bound", () => {
    assert.equal(Label.safeParse("").success, false)
    assert.equal(Label.safeParse("   ").success, false)
    assert.equal(Label.safeParse("\t\n ").success, false)
    assert.equal(Label.safeParse(longer).success, false)
  })

  test("says what is wrong with a blank one", () => {
    const result = Label.safeParse("   ")
    assert.equal(result.success, false)
    assert.deepEqual(
      (result.error?.issues ?? []).map((issue) => issue.message),
      ["Give something other than whitespace"],
    )
  })
})

describe("Paragraph", () => {
  test("takes the several lines a label has no room for: an address, an access condition, a note", () => {
    const address = "Parkvej 18, 2. th\n2000 Frederiksberg"
    assert.equal(Paragraph.parse(address), address)
    assert.equal(Paragraph.parse("p".repeat(PARAGRAPH_MAX)), "p".repeat(PARAGRAPH_MAX))
  })

  test("is the same rule as Label with a longer bound: blank is refused, the text is stored as it arrived", () => {
    assert.equal(Paragraph.parse(" leading and trailing "), " leading and trailing ")
    assert.equal(Paragraph.safeParse("").success, false)
    assert.equal(Paragraph.safeParse("   ").success, false)
    assert.equal(Paragraph.safeParse("p".repeat(PARAGRAPH_MAX + 1)).success, false)
    assert.equal(PARAGRAPH_MAX, 2000)
  })

  test("says what is wrong with a blank one in the same words Label uses", () => {
    const result = Paragraph.safeParse("  ")
    assert.equal(result.success, false)
    assert.deepEqual(
      (result.error?.issues ?? []).map((issue) => issue.message),
      ["Give something other than whitespace"],
    )
  })
})

describe("the schemas that take a label", () => {
  const project = { name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen" }
  const invite = { email: "olivia.larsen@kystbyen.example", fullName: "Olivia Larsen", roleId: ID, allProjects: true as const }

  test("hold a write body to it: a blank name and a name past the bound are both refused, by path", () => {
    for (const name of ["   ", longer]) {
      const result = ProjectCreate.safeParse({ ...project, name })
      assert.equal(result.success, false, JSON.stringify(name))
      assert.deepEqual(
        (result.error?.issues ?? []).map((issue) => issue.path.join(".")),
        ["name"],
      )
    }
    for (const fullName of ["   ", longer]) {
      const result = UserInvite.safeParse({ ...invite, fullName })
      assert.equal(result.success, false, JSON.stringify(fullName))
      assert.deepEqual(
        (result.error?.issues ?? []).map((issue) => issue.path.join(".")),
        ["fullName"],
      )
    }
  })

  test("hold GET /me to the same rule, so one spelling covers the resource and the summary of it", () => {
    const me = {
      user: { id: ID, email: "olivia.larsen@kystbyen.example", fullName: "Olivia Larsen", status: "active", allProjects: true, primaryAdministrator: true },
      company: { id: ID, name: "Kystbyen Renovation" },
      role: { id: ID, key: "company-administrator", name: "Company Administrator", scope: "Company", system: true, grants: [] },
      projects: [{ id: ID, name: "Copenhagen Central" }],
      serviceProvider: null,
    }
    assert.deepEqual(Me.parse(me), me)
    assert.equal(Me.safeParse({ ...me, user: { ...me.user, fullName: "  " } }).success, false)
    assert.equal(Me.safeParse({ ...me, company: { ...me.company, name: "" } }).success, false)
  })
})
