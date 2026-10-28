// The service-provider workspace on the Pilot (#291 slice 24, C24): the
// restricted shell scoped by `/me` instead of the fixture provider. A
// Service Provider's account works in no project — the API fences every row
// it reads to its provider (`servesRoute`, `reachesFleet`, `ticketReach`, its
// own team) — so the shell pins no project and reads the role's grants as
// `/me` answers them, never the fixture role's matrix.
//
// What it writes beyond the API's reads: its team, invited under the provider
// through `POST /users` on a provider's role (`PROVIDER_ROLE_SCOPE`), and its
// tickets, raised about a route it runs, in that route's project. Fixture
// mode keeps NordRen ApS, its fixture role and its fixture forms untouched.
import type { Grant } from "@waste/contracts/permissions"
import { PROVIDER_ROLE_SCOPE } from "@waste/domain/access/system-roles"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"

import { allows, type Grants } from "../api/grants"
import { accessMapOf, DEACTIVATE_USER, REACTIVATE_USER } from "../api/records/organisation"
import { PICKUPS_MODULE } from "../api/records/pickups"
import { COMPLETE_ACTIVITY, WITHDRAW_ACTIVITY } from "../api/records/provider-activities"
import { ASSIGN_ROUTE, DISPATCH_ROUTE, ROUTES_MODULE } from "../api/records/routes"
import type { BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { mintedRecord } from "./containers"
import type { RoleAccessMap } from "./role-permissions"
import { createTicketRecord, tokenOptions } from "./tickets"

/** Service Providers › Service Provider Workspace: a provider's own team, read and invited through `/users` (#291 C24). */
export const TEAM_MODULE: ModuleLocation = { workspaceId: "service-providers", moduleId: "service-provider-workspace" }

/** The provider `/me` names, as the shell reads it: null for an office account. */
export type ProviderOfMe = { id: string; legalName: string }

/** What the shell reads off `/me`: whose workspace it is, who acts in it, and what its role allows. */
export type ProviderWorkspace = {
  /** The provider's server id. */
  providerId: string
  legalName: string
  /** The account's name, which the forms stamp as the actor. */
  actorName: string
  /** The role's grants as `/me` answers them: what the workspace's modules and actions read. */
  access: RoleAccessMap
}

type MeOfProvider = {
  user: { fullName: string }
  role: { grants: readonly Grant[] }
  serviceProvider: ProviderOfMe | null
}

/** The workspace `/me` describes, or null for an account that is no provider's. */
export function providerWorkspaceOf(me: MeOfProvider): ProviderWorkspace | null {
  if (me.serviceProvider === null) return null
  return {
    providerId: me.serviceProvider.id,
    legalName: me.serviceProvider.legalName,
    actorName: me.user.fullName,
    access: accessMapOf(me.role.grants),
  }
}

/**
 * The commands a Service Provider's account sends, by module (#291 slice
 * 23b): it crews a route it runs and sends it to its own driver, and switches
 * its own team's accounts off and on again. Every other command of a module —
 * a stop's, a ticket's, a ticket's patch — is the office's: the API finds no
 * row for a provider's, so no surface offers it one.
 */
/** A row's own fields changed by its patch, which a surface asks after as it asks after a command: a provider's account patches no ticket. */
export const PATCH_RECORD = "patch"

export const PROVIDER_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "route-studio.routes": [ASSIGN_ROUTE, DISPATCH_ROUTE],
  [`${TEAM_MODULE.workspaceId}.${TEAM_MODULE.moduleId}`]: [DEACTIVATE_USER, REACTIVATE_USER],
  // Its own proposals and notes (#474): withdrawn, completed and corrected; the office alone decides a proposal.
  "service-providers.activities": [WITHDRAW_ACTIVITY, COMPLETE_ACTIVITY, PATCH_RECORD],
}

/**
 * Whether a surface offers a command of a module to the account signed in:
 * an office account every one, as before; a provider's account those the
 * API gives a provider (`PROVIDER_COMMANDS`), and only where its role allows
 * `edit` on the module.
 */
export function commandOffered(account: { provider: boolean; grants: Grants | undefined }, moduleKey: string, command: string): boolean {
  if (!account.provider) return true
  return (PROVIDER_COMMANDS[moduleKey] ?? []).includes(command) && allows(account.grants, moduleKey, "edit")
}

/** What an office account is told on the provider's workspace on the Pilot: it is a provider's alone. */
export const NOT_A_PROVIDER_ACCOUNT = "This workspace is a service provider's. Your account is the office's: the providers' routes, fleet, tickets and teams are in the office's own workspaces."

// ---------------------------------------------------------------------------
// The team
// ---------------------------------------------------------------------------

/** A team member is a user account; the module reads its roles beside them, which are never its rows. */
export const isTeamMember = (record: Pick<BusinessRecord, "id" | "recordKind">): boolean =>
  record.recordKind === "User" || record.recordKind === "Service provider user" || record.id.startsWith("user-")

/** A role a team may be given: a provider's (`PROVIDER_ROLE_SCOPE`), the only scope the API's team door gives. */
export const isTeamRole = (record: Pick<BusinessRecord, "recordKind" | "submittedValues">): boolean =>
  record.recordKind === "Role" && record.submittedValues?.scope === PROVIDER_ROLE_SCOPE

/** The roles the invite offers, by web id: a provider's, named as the company named them. */
export const teamRoleOptions = (records: readonly BusinessRecord[]): BusinessFormOption[] =>
  records.filter(isTeamRole).map((record) => ({ value: record.id, label: record.name }))

/**
 * Add user on the Pilot: `UserInvite` with a provider's access — a name, an
 * e-mail, a provider's role — into the signed-in provider's own team, which
 * the dialog stamps. The office invites a provider's accounts in Settings ›
 * Users & roles, whose module it reads.
 */
export function teamInviteForm(roles: readonly BusinessFormOption[]): BusinessFormSchema {
  return {
    key: `${TEAM_MODULE.workspaceId}.${TEAM_MODULE.moduleId}`,
    mode: "create",
    recordKind: "Service provider user",
    title: "Add user",
    description: "Invite a person into your service provider's team.",
    submitLabel: "Add user",
    nameField: "fullName",
    execution: { kind: "create-record", completionMessage: "User invited." },
    sections: [
      {
        id: "invite",
        title: "User access",
        fields: [
          { id: "fullName", label: "Full name", type: "text", required: true },
          { id: "email", label: "Email", type: "email", required: true, description: "The address the person signs in with. No e-mail is sent: the login is made with the same address." },
          { id: "roleId", label: "Role", type: "select", required: true, options: [...roles], description: "A service provider's role, allowing nothing your own does not." },
        ],
      },
    ],
  }
}

/** The account an invite makes, before the API answers it: invited until the person first signs in. `serviceProviderId` names the provider by its web id or its chip. */
export function createTeamMemberRecord(values: BusinessFormValues, serviceProviderId: string, now: number): BusinessRecord {
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string).trim() : "")
  const record = mintedRecord({
    id: `team-user-${now}`,
    name: text("fullName"),
    status: "Invited",
    recordKind: "Service provider user",
    values: { fullName: text("fullName"), email: text("email"), roleId: text("roleId"), serviceProviderId },
  })
  return { ...record, serviceProviderId }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/**
 * New ticket from a provider's account: the case and the route it is about,
 * one the provider runs — the API refuses any other — and the stop where
 * there is one. The project is the route's, the source the provider's
 * workspace, and an assignee the office's to give, so none is asked.
 */
export const PROVIDER_TICKET_FORM: BusinessFormSchema = {
  key: "operate.tickets",
  mode: "create",
  recordKind: "Ticket",
  title: "New ticket",
  description: "Raise a case about a route you run, for the office to resolve.",
  submitLabel: "Raise ticket",
  nameField: "subject",
  execution: { kind: "create-record", completionMessage: "Ticket raised." },
  sections: [
    {
      id: "case",
      title: "Case",
      fields: [
        { id: "subject", label: "Subject", type: "text", required: true },
        { id: "description", label: "Description", type: "textarea", required: true, description: "What happened, or what is asked." },
        { id: "kind", label: "Kind", type: "select", required: true, options: tokenOptions(TICKET_KINDS) },
        { id: "priority", label: "Priority", type: "select", defaultValue: "none", options: tokenOptions(TICKET_PRIORITIES) },
      ],
    },
    {
      id: "links",
      title: "What it is about",
      fields: [
        { id: "routeId", label: "Route", type: "select", required: true, relation: ROUTES_MODULE, description: "A route you run." },
        { id: "pickupId", label: "Stop", type: "select", relation: PICKUPS_MODULE, description: "A stop of that route." },
      ],
    },
  ],
}

/** The project a route record is in, by web id: the ticket's project. */
export const projectOfRoute = (route: Pick<BusinessRecord, "projectIds" | "submittedValues">): string | undefined => {
  const typed = route.submittedValues?.projectId
  return typeof typed === "string" && typed !== "" ? typed : route.projectIds?.[0]
}

/** A provider's ticket before the API answers it: the office's ticket, in its route's project, with no assignee. */
export function createProviderTicketRecord(values: BusinessFormValues, routes: readonly BusinessRecord[], now: number): BusinessRecord {
  const route = routes.find((record) => record.id === values.routeId)
  const projectId = route === undefined ? undefined : projectOfRoute(route)
  return createTicketRecord(values, { now, extra: projectId === undefined ? {} : { projectId } })
}
