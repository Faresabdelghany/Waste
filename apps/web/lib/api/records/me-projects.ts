// The person's projects from `/me`, where the role does not view the
// organisation (Issue #217). Only the Company Administrator views
// configure.organization, so for every other role nothing loaded carried a
// project, and a row's project resolved to an id chip (`project-<uuid>`).
// `/me` names the person's projects without that grant (the plan on #81:
// "the pinned project scope derives from /me's projects on the Pilot"), so
// the store files them in its state under `ME_PROJECTS`, a source the
// resolver reads beside the loaded modules and never a module: each under the
// web id the organisation module gives it (`projectWebIdOf`), so a row names
// its project as it would for an administrator. The pinned scope derives from
// the same projects (`projectScopeOfMe`). Each carries its timezone and its
// currency as the organisation's record does, so a row is read on its
// project's clock whatever the role views. A role that views the organisation
// reads its rows, whole, and nothing is filed here.
import type { Me } from "@waste/contracts/me"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { ALL_PROJECTS, type ProjectScope } from "@/lib/data/project-scope"

import { webIdOf } from "@/lib/records/fields"
import type { ModuleState, ServerRecordsState } from "./server-records"

/** Where the store files the person's `/me` projects: a key no module has. */
export const ME_PROJECTS = "me.projects"

export type MeProject = Me["projects"][number]

/** The web id the organisation module gives a project. */
export function projectWebIdOf(project: Pick<MeProject, "id">): string {
  return webIdOf("project", project.id)
}

/** A project as the resolver reads it: its web id and name, and its clock and currency under the organisation record's keys; nothing else its read would add. */
function projectRecordOf(project: MeProject): BusinessRecord {
  const id = projectWebIdOf(project)
  return {
    id,
    name: project.name,
    context: "Project",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: { Currency: project.currency, Timezone: project.timezone },
    related: [],
    source: "Waste API",
    freshness: "",
    projectIds: [id],
    recordKind: "Project",
    submittedValues: { timezone: project.timezone, currency: project.currency },
  }
}

/** The state with the person's projects filed under `ME_PROJECTS`, for the resolver: ready, since `/me` has answered. */
export function withMeProjects(state: ServerRecordsState, projects: readonly MeProject[]): ServerRecordsState {
  const records = projects.map(projectRecordOf)
  const filed: ModuleState = { status: "ready", records, serverIds: new Map(records.map((record, index) => [record.id, projects[index].id])), problem: null, loadedAt: null }
  return new Map(state).set(ME_PROJECTS, filed)
}

/**
 * The project scope a workspace pins on the Pilot: the one project `/me`
 * names, where the person works in exactly one; every project otherwise —
 * for a person who works in several, for one in none (a provider's user,
 * whose rows the API fences by their provider), and while `/me` is unread.
 */
export function projectScopeOfMe(projects: readonly MeProject[] | undefined): ProjectScope {
  return projects?.length === 1 ? (projectWebIdOf(projects[0]) as ProjectScope) : ALL_PROJECTS
}
