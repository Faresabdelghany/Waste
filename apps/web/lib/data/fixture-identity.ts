// Who the prototype shows as signed in, per shell, in fixture mode. On the
// Pilot the account is `/me`'s and none of these is shown.
export type FixtureIdentity = {
  name: string
  detail: string
  initials: string
  avatarUrl?: string
}

/** The project the office's shell works in, as its sidebar names it: on the Pilot the workspace pins it where `/me` names it (`projectScopeOfMe`). */
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
}

export const CITIZEN_IDENTITY: FixtureIdentity = {
  name: "Østerbro Housing",
  detail: "Authorized property user",
  initials: "ØH",
}
