// The person's projects from `/me`, where the role does not view the
// organisation (Issue #217). Only the Company Administrator views
// configure.organization, so for every other role nothing loaded carried a
// project, a row's project resolved to an id chip (`project-<uuid>`), and the
// workspace's pinned scope — the organisation module's id for the seeded
// project, `project-copenhagen` — matched no row of any project-scoped
// switched module. `/me` names the person's projects without that grant (the
// plan on #81: "the pinned project scope derives from /me's projects on the
// Pilot"), so the store files them in its state under `ME_PROJECTS`, a
// source the resolver reads beside the loaded modules and never a module:
// each under the web id the organisation module gives it — the fixture's of
// its name, else `project-<uuid>` (`projectWebIdOf`) — so a row names its
// project as it would for an administrator. The pinned scope derives from the
// same projects (`projectScopeOfMe`). A role that views the organisation
// reads its rows, whole, and nothing is filed here.
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { ALL_PROJECTS, type ProjectScope } from "@/lib/data/project-scope"

import { fixtureNamed, webIdOf } from "./adapter"
import type { ModuleState, ServerRecordsState } from "./server-records"

/** Where the store files the person's `/me` projects: a key no module has. */
export const ME_PROJECTS = "me.projects"

/** A project as `/me` names it. */
export type MeProject = { id: string; name: string }

/** The web id the organisation module gives a project: the fixture's of its name, the seed's own derivation, else `project-<uuid>`. */
export function projectWebIdOf(project: MeProject, fixtures: readonly BusinessRecord[]): string {
  return fixtureNamed(fixtures, "project", [project.name])?.id ?? webIdOf("project", project.id)
}

/** A project as the resolver reads it: its web id and name, nothing the organisation's read would add. */
function projectRecordOf(project: MeProject, fixtures: readonly BusinessRecord[]): BusinessRecord {
  const id = projectWebIdOf(project, fixtures)
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
    companyId: FIXTURE_COMPANY_ID,
    projectIds: [id],
    recordKind: "Project",
  }
}

/** The state with the person's projects filed under `ME_PROJECTS`, for the resolver: ready, since `/me` has answered. */
export function withMeProjects(state: ServerRecordsState, projects: readonly MeProject[], fixtures: readonly BusinessRecord[]): ServerRecordsState {
  const records = projects.map((project) => projectRecordOf(project, fixtures))
  const filed: ModuleState = { status: "ready", records, serverIds: new Map(records.map((record, index) => [record.id, projects[index].id])), problem: null, loadedAt: null }
  return new Map(state).set(ME_PROJECTS, filed)
}

/**
 * The project scope a workspace pins on the Pilot: `fallback`, the default,
 * while `/me` is unread and wherever the person works in it; else their
 * first project, `/me`'s order; every project for a person with none, a
 * provider's user, whose rows the API fences by their provider.
 */
export function projectScopeOfMe(projects: readonly MeProject[] | undefined, fixtures: readonly BusinessRecord[], fallback: ProjectScope): ProjectScope {
  if (projects === undefined) return fallback
  if (projects.length === 0) return ALL_PROJECTS
  const ids = projects.map((project) => projectWebIdOf(project, fixtures) as ProjectScope)
  return ids.includes(fallback) ? fallback : ids[0]
}
