// A Company made outside the seed (C33 of #291, row 18.8): the rows a tenant
// needs before its first administrator signs in, written in one transaction
// under the new company's fence. The company starts `onboarding`, with:
//   the rows every company starts with (`companyDefaultRows`,
//   commands/company-defaults.ts): the system roles and their grants, the
//   Decommission Reasons and a default Ticket Type per kind;
//   its first Project; and
//   its primary Company Administrator, an Invitation in every project — an
//   account no Login is bound to yet, which the access token hook binds on
//   first sign-in by its address.
// Nothing is sent and no Login is made: on the Pilot the Owner makes the
// Login (supabase/README.md), and automatic delivery waits on the owner's
// decisions recorded on #390. Who may run this is the caller's question: the
// owner-only script (scripts/provision-company.ts), never a tenant's request.
//
// The seed spells the demo tenant's starting rows through the same builders,
// on its fixed ids, so "the rows a company starts with" is spelled once while
// the seed stays an upsert that writes nothing a second time.
//
// Two refusals, judged before anything is written: a company the register
// knows already — `unique (country, registration_number)` — and an address
// with an open Invitation in any company, since the hook binds a Login to the
// one open Invitation carrying its address and two would bind neither
// (migration 0005). The second reads across companies, so the caller runs as
// a role that sees them all: the owner.
import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"
import { Refused } from "@waste/domain/refusal"
import { and, eq, isNull } from "drizzle-orm"

import type { Db } from "../client"
import { role, roleGrant, userAccount } from "../schema/access"
import { company, project } from "../schema/organisation"
import { ticketType } from "../schema/resolution"
import { decommissionReason } from "../schema/stock"
import { withCompany } from "../tenant"
import { companyDefaultRows } from "./company-defaults"

/** What a new company is made from. */
export type CompanyProvision = {
  company: { name: string; legalName: string; registrationNumber: string; country: string }
  project: { name: string; kind: string; language: string; currency: string; timezone: string }
  administrator: { email: string; fullName: string }
}

/** What was made, by id. */
export type ProvisionedCompany = { companyId: string; projectId: string; administratorId: string; roleIds: Readonly<Record<SystemRoleKey, string>> }

/** What a company the register knows already is told. */
export const companyRegistered = (country: string, registrationNumber: string): string => `A company is registered as ${registrationNumber} in ${country} already`
/** What an address with an open Invitation is told. */
export const invitationOpen = (email: string): string =>
  `${email} has an open invitation in another company already; a Login binds to one open invitation, so the first administrator needs another address or that invitation withdrawn`

/**
 * Makes the company and everything it starts with in one transaction, and
 * answers the ids. `db` is a pool's drizzle face, not a transaction: the
 * company's fence is set for the transaction this opens (`withCompany`), so
 * the tenant fence holds every row to the new company. `newId` mints the ids.
 */
export async function provisionCompany(db: Db, provision: CompanyProvision, newId: () => string): Promise<ProvisionedCompany> {
  const email = provision.administrator.email.trim().toLowerCase()
  const [registered] = await db
    .select({ id: company.id })
    .from(company)
    .where(and(eq(company.country, provision.company.country), eq(company.registrationNumber, provision.company.registrationNumber)))
    .limit(1)
  if (registered !== undefined) throw Refused.conflict(companyRegistered(provision.company.country, provision.company.registrationNumber))
  const [invited] = await db
    .select({ id: userAccount.id })
    .from(userAccount)
    .where(and(eq(userAccount.email, email), isNull(userAccount.authUserId), isNull(userAccount.deactivatedAt)))
    .limit(1)
  if (invited !== undefined) throw Refused.conflict(invitationOpen(email))

  const companyId = newId()
  const projectId = newId()
  const administratorId = newId()
  const roleIds = Object.fromEntries(SYSTEM_ROLES.map((systemRole) => [systemRole.key, newId()])) as Record<SystemRoleKey, string>
  const idOf = (key: SystemRoleKey) => roleIds[key]
  const starts = companyDefaultRows(companyId, { role: idOf, next: newId })
  await withCompany(db, companyId, async (tx) => {
    await tx.insert(company).values({ id: companyId, companyId, ...provision.company, status: "onboarding" })
    await tx.insert(role).values(starts.roles)
    await tx.insert(roleGrant).values(starts.grants)
    await tx.insert(decommissionReason).values(starts.decommissionReasons)
    await tx.insert(ticketType).values(starts.ticketTypes)
    await tx.insert(project).values({ id: projectId, companyId, ...provision.project, status: "onboarding" })
    await tx.insert(userAccount).values({ id: administratorId, companyId, email, fullName: provision.administrator.fullName, roleId: idOf("company-administrator"), allProjects: true, primaryAdministrator: true })
  })
  return { companyId, projectId, administratorId, roleIds }
}
