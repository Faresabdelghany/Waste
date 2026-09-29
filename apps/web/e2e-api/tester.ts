// The second, projects-scoped account the suite proves isolation and a grant
// refusal with (Issue #151, decision Q5 of #131): a User Account invited
// through the API on the Route Planner role with Project Access to Copenhagen
// Central alone, whose Login the stack already holds from
// `LOCAL_EXTRA_LOGINS`. Until #163 lands no surface of the product sends
// `POST /users`, so the Invitation is made here, under the administrator's
// own browser session; when Users & Roles writes to the API, this moves into
// the browser like the other round trips.
//
// Idempotent, since a developer's stack outlives a run: an account the
// address already has is brought to this role and this access with a patch,
// and switched on again if a run left it deactivated.
import type { APIRequestContext } from "@playwright/test"

import { expect } from "./fixtures"

export type Page<Item> = { items: Item[]; nextCursor: string | null }
export type Project = { id: string; name: string }
export type Role = { id: string; key: string | null; name: string }
export type User = { id: string; email: string; fullName: string; roleId: string; allProjects: boolean; projectIds: string[]; serviceProviderId: string | null; status: string }

/** The Route Planner: reads Planning and the customers, and has no grant on the organisation, the providers or the accounts. */
export const TESTER_ROLE = "Route Planner"
export const TESTER_PROJECT = "Copenhagen Central"

/** Every item of a list, page after page, as the web's `listAll` walks it. */
export async function listAll<Item>(api: APIRequestContext, path: string): Promise<Item[]> {
  const items: Item[] = []
  let cursor: string | undefined
  do {
    const response = await api.get(path, { params: { limit: 200, ...(cursor === undefined ? {} : { cursor }) } })
    expect(response.status(), `GET ${path}`).toBe(200)
    const page = (await response.json()) as Page<Item>
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return items
}

export async function projectNamed(api: APIRequestContext, name: string): Promise<Project> {
  const project = (await listAll<Project>(api, "/projects")).find((candidate) => candidate.name === name)
  if (project === undefined) throw new Error(`the seed holds no project named ${name}`)
  return project
}

export async function roleNamed(api: APIRequestContext, name: string): Promise<Role> {
  const role = (await listAll<Role>(api, "/roles")).find((candidate) => candidate.name === name)
  if (role === undefined) throw new Error(`the seed holds no role named ${name}`)
  return role
}

/** The tester's account as it should be, made or brought to that shape. */
export async function ensureTester(api: APIRequestContext, email: string): Promise<{ user: User; project: Project; role: Role }> {
  const [project, role] = await Promise.all([projectNamed(api, TESTER_PROJECT), roleNamed(api, TESTER_ROLE)])
  const wanted = { roleId: role.id, projectIds: [project.id] }
  const invited = await api.post("/users", { data: { email, fullName: "E2E Tester", ...wanted } })
  if (invited.status() === 201) return { user: (await invited.json()) as User, project, role }
  expect(invited.status(), "POST /users for an address already invited").toBe(409)
  let existing = (await listAll<User>(api, "/users")).find((candidate) => candidate.email === email.toLowerCase())
  if (existing === undefined) throw new Error(`POST /users answered 409 for ${email}, but no account carries the address`)
  // A tester left switched off by a run that ended between its deactivation and its reactivation (account-refusal.spec.ts) is switched on again here, so the stack heals itself.
  if (existing.status === "deactivated") {
    const reactivated = await api.post(`/users/${existing.id}/reactivate`)
    expect(reactivated.status(), `POST /users/${existing.id}/reactivate`).toBe(200)
    existing = (await reactivated.json()) as User
  }
  if (existing.roleId === wanted.roleId && !existing.allProjects && existing.serviceProviderId === null && existing.projectIds.join() === wanted.projectIds.join()) {
    return { user: existing, project, role }
  }
  const patched = await api.patch(`/users/${existing.id}`, { data: wanted })
  expect(patched.status(), `PATCH /users/${existing.id}`).toBe(200)
  return { user: (await patched.json()) as User, project, role }
}
