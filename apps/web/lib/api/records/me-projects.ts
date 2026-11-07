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
// the same projects (`projectScopeOfMe`). A role that views the organisation
// reads its rows, whole, and nothing is filed here.
import type { BusinessRecord } from "@/lib/data/business-modules"
import { ALL_PROJECTS, type ProjectScope } from "@/lib/data/project-scope"

import { webIdOf } from "./adapter"
import type { ModuleState, ServerRecordsState } from "./server-records"

/** Where the store files the person's `/me` projects: a key no module has. */
export const ME_PROJECTS = "me.projects"

/** A project as `/me` names it. */
export type MeProject = { id: string; name: string }

/** The web id the organisation module gives a project. */
export function projectWebIdOf(project: Pick<MeProject, "id">): string {
  return webIdOf("project", project.id)
}

/** A project as the resolver reads it: its web id and name, nothing the organisation's read would add. */
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
    facts: {},
    related: [],
    source: "Waste API",
    freshness: "",
    projectIds: [id],
    recordKind: "Project",
  }
}

/** The state with the person's projects filed under `ME_PROJECTS`, for the resolver: ready, since `/me` has answered. */
export function withMeProjects(state: ServerRecordsState, projects: readonly MeProject[]): ServerRecordsState {
  const records = projects.map(projectRecordOf)
  const filed: ModuleState = { status: "ready", records, serverIds: new Map(records.map((record, index) => [record.id, projects[index].id])), problem: null, loadedAt: null }
  return new Map(state).set(ME_PROJECTS, filed)
}

/**
 * The project scope a workspace pins on the Pilot: the project named
 * `preferred` (the operator shell's, as its sidebar names it) wherever the
 * person works in it; else their first project, `/me`'s order; every project
 * while `/me` is unread and for a person with none, a provider's user, whose
 * rows the API fences by their provider.
 */
export function projectScopeOfMe(projects: readonly MeProject[] | undefined, preferred: string): ProjectScope {
  if (projects === undefined || projects.length === 0) return ALL_PROJECTS
  const project = projects.find((candidate) => candidate.name === preferred) ?? projects[0]
  return projectWebIdOf(project) as ProjectScope
}
