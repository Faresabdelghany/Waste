// The service-provider workspace on the Pilot (#291 C24): the shell read off
// `/me` — the provider, the actor, the role's grants — the team switched onto
// `/users` under its own module, its invite held against the contracts'
// `UserInvite`, and a provider's ticket opened in its route's project, which
// it names by the id chip its route carries since a provider reads no project.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { UserInvite } from "@waste/contracts/access"
import { TicketCreate } from "@waste/contracts/tickets"
import { PROVIDER_ROLE_SCOPE } from "@waste/domain/access/system-roles"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../../data/business-modules"
import { createProviderTicketRecord, createTeamMemberRecord, isTeamMember, isTeamRole, PROVIDER_TICKET_FORM, providerWorkspaceOf, TEAM_MODULE, teamInviteForm, teamRoleOptions } from "../../data/provider-workspace"
import { isLocalRefusal, webIdOf, type MappingContext, type Resolver } from "../records/adapter"
import { serverModuleOf } from "../records/modules"
import { teamModule, teamUserAdapter, userAdapter } from "../records/organisation"
import { ticketAdapter } from "../records/tickets"
import { clientOver, json, scripted } from "./scripted-fetch"

const providerId = "01a0d2a4-a280-7003-8000-000000000001"
const projectId = "01a0d2a4-a280-7002-8000-000000000001"
const routeId = "01a0d2a4-a280-7030-8000-000000000001"
const roleId = "01a0d2a4-a280-7001-8000-000000000009"

const record = (id: string, extra: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id,
  name: id,
  context: "",
  status: "Active",
  owner: "",
  value: "",
  updated: "Now",
  description: "",
  facts: {},
  related: [],
  source: "Waste API",
  freshness: "Now",
  companyId: FIXTURE_COMPANY_ID,
  ...extra,
})

/** A resolver over the rows given, each by its web id and server id. */
function resolverOf(rows: readonly [BusinessRecord, string][]): Resolver {
  return {
    byServerId: (serverId) => rows.find(([, id]) => id === serverId)?.[0],
    serverIdOf: (webId) => rows.find(([row]) => row.id === webId)?.[1],
    find: (predicate) => rows.map(([row]) => row).find(predicate),
    filter: (predicate) => rows.map(([row]) => row).filter(predicate),
  }
}

const context = (resolve: Resolver): MappingContext => ({ fixtures: [], resolve })

describe("the shell reads /me", () => {
  test("a provider's account is its provider's workspace, acted in by its name, under its role's grants", () => {
    const workspace = providerWorkspaceOf({
      user: { fullName: "Lars Mikkelsen" },
      role: { grants: [{ moduleKey: "operate.tickets", actions: ["view", "create"] }, { moduleKey: "route-studio.routes", actions: ["view", "edit"] }] },
      serviceProvider: { id: providerId, legalName: "NordRen ApS" },
    })
    assert.deepEqual(workspace, {
      providerId,
      legalName: "NordRen ApS",
      actorName: "Lars Mikkelsen",
      access: { "operate.tickets": ["view", "create"], "route-studio.routes": ["view", "edit"] },
    })
  })

  test("an office account has no provider's workspace", () => {
    assert.equal(providerWorkspaceOf({ user: { fullName: "Olivia Larsen" }, role: { grants: [] }, serviceProvider: null }), null)
  })
})

describe("the team", () => {
  test("is switched under its own module, the roles read before the members", () => {
    assert.equal(serverModuleOf(TEAM_MODULE.workspaceId, TEAM_MODULE.moduleId), teamModule)
    assert.deepEqual(teamModule.resources.map((adapter) => adapter.prefix), ["role", "user"])
  })

  test("lists the providers' accounts alone, never the office's", async () => {
    const office = { id: "a", serviceProviderId: null }
    const member = { id: "b", serviceProviderId: providerId }
    const { fetch, calls } = scripted([() => json({ items: [office, member], nextCursor: null })])
    const users = await teamUserAdapter.list!(clientOver(fetch))
    assert.deepEqual(users, [member])
    assert.equal(new URL(calls[0].url).pathname, "/users")
  })

  test("its rows are the accounts, and the roles it offers a provider's", () => {
    assert.equal(isTeamMember({ id: "user-0190", recordKind: "User" }), true)
    assert.equal(isTeamMember({ id: "team-user-1", recordKind: "Service provider user" }), true)
    assert.equal(isTeamMember({ id: "role-driver", recordKind: "Role" }), false)
    const foreman = record("role-service-provider-foreman", { name: "Service Provider Foreman", recordKind: "Role", submittedValues: { scope: PROVIDER_ROLE_SCOPE } })
    const planner = record("role-route-planner", { name: "Route Planner", recordKind: "Role", submittedValues: { scope: "Company or project" } })
    assert.equal(isTeamRole(foreman), true)
    assert.equal(isTeamRole(planner), false)
    assert.deepEqual(teamRoleOptions([foreman, planner]), [{ value: foreman.id, label: "Service Provider Foreman" }])
  })

  test("a provider's account invites into its own team; the office picks the provider", () => {
    const ids = (providers: null | { value: string; label: string }[]) => teamInviteForm([], providers).sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(ids(null), ["fullName", "email", "roleId"])
    assert.deepEqual(ids([{ value: "service-provider-nordren", label: "NordRen ApS" }]), ["serviceProviderId", "fullName", "email", "roleId"])
  })

  test("an invite goes out as `UserInvite` under the provider, on the role picked", () => {
    const provider = record("service-provider-nordren", { recordKind: "Service provider company" })
    const role = record("role-service-provider-foreman", { recordKind: "Role" })
    const invited = createTeamMemberRecord({ fullName: " Mette Holm ", email: "mette@nordren.example", roleId: role.id }, provider.id, 1)
    assert.equal(teamUserAdapter.owns(invited), true)
    const body = userAdapter.toCreateBody!(invited, context(resolverOf([[provider, providerId], [role, roleId]])))
    assert.equal(isLocalRefusal(body), false)
    assert.deepEqual(UserInvite.parse(body), { email: "mette@nordren.example", fullName: "Mette Holm", roleId, serviceProviderId: providerId })
  })
})

describe("a provider's ticket", () => {
  test("asks for the route it is about, and no project, source or assignee", () => {
    const ids = PROVIDER_TICKET_FORM.sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(ids, ["subject", "description", "kind", "priority", "routeId", "pickupId"])
    assert.equal(PROVIDER_TICKET_FORM.sections.flatMap((section) => section.fields).find((field) => field.id === "routeId")?.required, true)
  })

  test("is opened in its route's project, named by the chip a provider reads it by", () => {
    const projectChip = webIdOf("project", projectId)
    const route = record(webIdOf("route", routeId), { recordKind: "Route", projectIds: [projectChip], submittedValues: { projectId: projectChip, status: "planned" } })
    const ticket = createProviderTicketRecord({ subject: "Gate locked", description: "The yard gate at Parkvej was locked.", kind: "complaint", priority: "none", routeId: route.id }, [route], 1)
    assert.equal(ticket.submittedValues?.projectId, projectChip)
    const body = ticketAdapter.toCreateBody!(ticket, context(resolverOf([[route, routeId]])))
    assert.equal(isLocalRefusal(body), false)
    const parsed = TicketCreate.parse(body)
    assert.equal(parsed.projectId, projectId)
    assert.equal(parsed.links?.routeId, routeId)
    assert.equal(parsed.assigneeUserAccountId, undefined)
  })

  test("names no project where it names no route the store holds", () => {
    const ticket = createProviderTicketRecord({ subject: "Gate locked", description: "Locked.", kind: "complaint" }, [], 1)
    assert.equal(ticket.submittedValues?.projectId, undefined)
    assert.equal(isLocalRefusal(ticketAdapter.toCreateBody!(ticket, context(resolverOf([])))), true)
  })
})
