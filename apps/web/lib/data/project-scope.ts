// The workspace project scope (issue #44). The vocabulary is the project
// records of the configure.organization module — the fixture three and any
// the browser holds — so a project the fixture list never knew (Cairo
// Operations, round 3) scopes its calendars, planning areas and schemes like
// any other. The header offers no switcher (removed 2026-09-03); the default
// scope is pinned by the workspace and a restricted shell pins its own.
import { isSoftDeleted } from "@waste/domain/record-visibility"

import type { BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"

/** Every permitted project rather than one. */
export const ALL_PROJECTS = "all"

/**
 * The id of a project record. The prefix is the one rule the web reads a
 * project record by — the Settings panes, the relation options and the
 * fixture ids all spell it — so a created project qualifies by its id
 * alone.
 */
export type ProjectRecordId = `project-${string}`

/** One project record's id, or every permitted project. */
export type ProjectScope = typeof ALL_PROJECTS | ProjectRecordId

export function isProjectRecordId(value: unknown): value is ProjectRecordId {
  return typeof value === "string" && value.startsWith("project-")
}

/**
 * The project records among the organisation module's, in record order,
 * a soft-deleted project left out: it is no scope to run in and no project
 * to stamp on a record.
 */
export function projectRecordsOf(
  organisationRecords: readonly BusinessRecord[],
): BusinessRecord[] {
  return organisationRecords.filter(
    (record) => isProjectRecordId(record.id) && !isSoftDeleted(record),
  )
}

/** The one project a scope pins, or null when it runs in every permitted project. */
export function pinnedProjectId(scope: ProjectScope): ProjectRecordId | null {
  return scope === ALL_PROJECTS ? null : scope
}

/**
 * Whether a record is shown under a scope: a company-wide record — no
 * project, or several — everywhere, a record of one project only in that
 * project's scope.
 */
export function isInProjectScope(
  record: Pick<BusinessRecord, "projectIds">,
  scope: ProjectScope,
): boolean {
  const pinned = pinnedProjectId(scope)
  if (pinned === null) return true
  if (!record.projectIds || record.projectIds.length !== 1) return true
  return record.projectIds[0] === pinned
}

/**
 * The project ids a record made under a scope carries: the project the form
 * chose, whichever scope the workspace runs in; else the pinned project; else
 * every project record.
 */
export function selectedProjectIds(
  scope: ProjectScope,
  values: BusinessFormValues,
  projects: readonly BusinessRecord[],
): string[] {
  if (isProjectRecordId(values.projectId)) return [values.projectId]
  const pinned = pinnedProjectId(scope)
  if (pinned !== null) return [pinned]
  return projects.map((project) => project.id)
}

/**
 * How a record's project scope reads: the project record's name, the id
 * when no record names it — never another project's name — and "All
 * permitted projects" for several.
 */
export function projectScopeLabel(
  projectIds: readonly string[],
  projects: readonly BusinessRecord[],
): string {
  if (projectIds.length > 1) return "All permitted projects"
  const [projectId] = projectIds
  if (projectId === undefined) return ""
  return projects.find((project) => project.id === projectId)?.name ?? projectId
}
