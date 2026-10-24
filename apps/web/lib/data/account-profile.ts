// The person signed in on the Pilot, as Settings › Account & appearance and
// the sidebar's account menu show them (#150, #282): name, e-mail, role and
// projects as `/me` answered, never the fixture persona. Until `/me` has
// answered, the e-mail Auth gave at sign-in stands in for the name. The
// contracts are imported as types only, so no zod reaches the bundle.
import type { Me } from "@waste/contracts/me"

/** What the account pane's profile reads, each a line a person reads. */
export type AccountProfile = { name: string; email: string; role: string; projects: string; initials: string }

/** What a line `/me` has not answered yet reads. */
const READING = "Reading your account…"

/** The first letters of the first and last names; one letter for a single word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? ""
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : ""
  return `${first}${last}`.toUpperCase()
}

/** The projects an account works in, as `/me` lists them: every one for an account that works in all of them, and a provider's account by its provider, since it lists none. */
function projectsOf(me: Me): string {
  const names = me.projects.map((project) => project.name).join(", ")
  if (me.user.allProjects) return `All projects: ${names}`
  if (me.projects.length > 0) return names
  return me.serviceProvider === null ? "No project" : `Through ${me.serviceProvider.legalName}'s service areas`
}

/** The signed-in person as the account pane shows them; `signedInEmail` is Auth's, standing in until `/me` has answered. */
export function profileOf(me: Me | null, signedInEmail: string | null | undefined): AccountProfile {
  if (me === null) {
    const email = signedInEmail ?? ""
    return { name: email, email, role: READING, projects: READING, initials: initialsOf(email) }
  }
  return {
    name: me.user.fullName,
    email: me.user.email,
    role: me.user.primaryAdministrator ? `${me.role.name} · Primary administrator` : me.role.name,
    projects: projectsOf(me),
    initials: initialsOf(me.user.fullName),
  }
}
