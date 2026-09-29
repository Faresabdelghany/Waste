import { expect, problemOf, test } from "./fixtures"
import { uniqueName } from "./env"
import { projectNamed, roleNamed, TESTER_PROJECT, type User } from "./tester"

// Scenario 4, the two switched modules whose product surfaces do not yet
// write to the API — Company & Projects and Users & Roles read from it but
// Settings still writes to the browser's organisation store until #163 —
// so their round trips run through the API under the administrator's own
// browser session: create, `Location`, read back there, edit, and the API's
// refusal in its own sentence. When #163 lands they move into the browser,
// as the providers' and the customers' already are (registry-round-trips).
type Project = { id: string; name: string; kind: string; status: string }

test("Company & Projects: a project round-trips with Location, and a second of the same name is refused by name", async ({ api }) => {
  const name = uniqueName("E2E project")
  const created = await api.post("/projects", { data: { name, kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen" } })
  expect(created.status()).toBe(201)
  const location = created.headers().location
  expect(location).toMatch(/^\/projects\/[0-9a-f-]{36}$/)
  const body = (await created.json()) as Project
  expect(location).toBe(`/projects/${body.id}`)
  expect(body).toMatchObject({ name, kind: "Contract", status: "onboarding" })

  const read = await api.get(location)
  expect(read.status()).toBe(200)
  expect(await read.json()).toEqual(body)

  const edited = await api.patch(location, { data: { kind: "Region", status: "active" } })
  expect(edited.status()).toBe(200)
  expect(await edited.json()).toMatchObject({ id: body.id, name, kind: "Region", status: "active" })
  expect((await (await api.get(location)).json()) as Project).toMatchObject({ kind: "Region", status: "active" })

  const duplicate = await api.post("/projects", { data: { name, kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen" } })
  expect(duplicate.status()).toBe(409)
  expect(await problemOf(duplicate)).toMatchObject({ status: 409, detail: `This company already has a project called ${JSON.stringify(name)}` })
})

test("Users & Roles: an invitation round-trips with Location, and the address cannot be invited twice", async ({ api }) => {
  const [project, role] = await Promise.all([projectNamed(api, TESTER_PROJECT), roleNamed(api, "Dispatcher")])
  // A fresh address every run, never the tester's (e2e-tester@…), which the isolation scenario signs in as.
  const email = `${uniqueName("e2e-invitee").replace(/\s+/g, "-").toLowerCase()}@waste-e2e.example`
  const invited = await api.post("/users", { data: { email, fullName: "E2E Invitee", roleId: role.id, projectIds: [project.id] } })
  expect(invited.status()).toBe(201)
  const location = invited.headers().location
  const body = (await invited.json()) as User
  expect(location).toBe(`/users/${body.id}`)
  expect(body).toMatchObject({ email, fullName: "E2E Invitee", roleId: role.id, allProjects: false, projectIds: [project.id], serviceProviderId: null, status: "invited" })

  const read = await api.get(location)
  expect(read.status()).toBe(200)
  expect(await read.json()).toEqual(body)

  const edited = await api.patch(location, { data: { fullName: "E2E Invitee, renamed" } })
  expect(edited.status()).toBe(200)
  expect(await edited.json()).toMatchObject({ id: body.id, fullName: "E2E Invitee, renamed" })

  const duplicate = await api.post("/users", { data: { email: email.toUpperCase(), fullName: "Somebody Else", roleId: role.id, projectIds: [project.id] } })
  expect(duplicate.status()).toBe(409)
  expect(await problemOf(duplicate)).toMatchObject({ status: 409, detail: `This company already has a user with the e-mail address ${JSON.stringify(email)}` })
})
