// What a Team's bodies hold to at the boundary (O30 of #290, row 7.20): its
// members each once and bounded, and a project's defaults — the team a
// ticket of a kind or a type waits with — each kind or type once.
import { eachOnceSentence } from "../requests"

/** The most members a set body may name: a form's list, not an import. */
export const TEAM_MEMBERS_MAX = 200

/** What a set of members naming an account twice is told. */
export const EACH_MEMBER_ONCE = eachOnceSentence("account")

/** What a project's defaults naming a kind or a type twice are told. */
export const EACH_KIND_ONCE = eachOnceSentence("kind or ticket type", "a ticket goes to one team")

/** What a new ticket, a patch moving a ticket's team, a rule or a project's default naming a retired team is told (`ACTIVE_TEAM_STATUSES`). */
export const retiredTeam = (name: string): string => `The team ${JSON.stringify(name)} is retired; a ticket waits with an active team`
