// Who the prototype shows as signed in, per shell, in fixture mode, and the
// seeded role it works under. On the Pilot the account is `/me`'s and none of
// these is shown or read.
import type { SystemRoleKey } from "@waste/domain/access/system-roles"

export type FixtureIdentity = {
  name: string
  detail: string
  initials: string
  avatarUrl?: string
  /** The seeded role whose charter the persona works under; none for a persona held back by nothing. */
  role?: SystemRoleKey
}

/** The project the office's shell works in, as its sidebar names it. */
export const OPERATOR_PROJECT_NAME = "Copenhagen Central"

export const OPERATOR_IDENTITY: FixtureIdentity = {
  name: "Olivia Larsen",
  detail: "Operations manager",
  initials: "OL",
  avatarUrl: "/avatar-profile.jpg",
}

export const SERVICE_PROVIDER_IDENTITY: FixtureIdentity = {
  name: "Lars Mikkelsen",
  detail: "NordRen ApS · Manager",
  initials: "LM",
  role: "service-provider-manager",
}

export const CITIZEN_IDENTITY: FixtureIdentity = {
  name: "Østerbro Housing",
  detail: "Authorized property user",
  initials: "ØH",
}
