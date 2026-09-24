// The workspace project scope is derived from the configure.organization
// project records (issue #44): the vocabulary is whatever project records
// exist, fixture or created, never a hard-coded union of two ids. These
// tests hold the rules the workspace scopes by — which records are
// projects, what a scope pins, which records it shows, which project ids a
// record made under it carries, and how a scope is labelled — and hold the
// fixture registry to `FIXTURE_PROJECT_IDS`.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { REGISTRY_VISIBILITY_FACT, SOFT_DELETED } from "@waste/domain/record-visibility"

import {
  FIXTURE_PROJECT_IDS,
  getModuleDefinition,
  type BusinessRecord,
} from "../business-modules"
import {
  ALL_PROJECTS,
  isInProjectScope,
  pinnedProjectId,
  projectRecordsOf,
  projectScopeLabel,
  selectedProjectIds,
  type ProjectScope,
} from "../project-scope"

const record = (
  id: string,
  name: string,
  overrides: Partial<BusinessRecord> = {},
): BusinessRecord => ({
  id,
  name,
  context: "",
  status: "Active",
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts: {},
  related: [],
  source: "",
  freshness: "",
  ...overrides,
})

const company = record("company-kystbyen-dk", "Kystbyen Renovation")
const copenhagen = record(FIXTURE_PROJECT_IDS.copenhagen, "Copenhagen Central")
const harbor = record(FIXTURE_PROJECT_IDS.harbor, "Harbor Commercial")
const cairo = record(FIXTURE_PROJECT_IDS.cairo, "Cairo Operations")
// A project created in the browser: the id prefix is the one rule, not the
// fixture list.
const created = record("project-7c1c0f2e-aarhus", "Aarhus North")
const deleted = record("project-deleted", "Closed Project", {
  facts: { [REGISTRY_VISIBILITY_FACT]: SOFT_DELETED },
})
const projects = [copenhagen, harbor, cairo, created]

const scopedTo = (...projectIds: string[]) =>
  record("calendar-x", "Calendar", { projectIds })

describe("projectRecordsOf", () => {
  test("keeps the organisation module's project records in order, the company and a soft-deleted project left out", () => {
    assert.deepEqual(
      projectRecordsOf([company, copenhagen, deleted, harbor, cairo, created]).map(
        (project) => project.id,
      ),
      [copenhagen.id, harbor.id, cairo.id, created.id],
    )
  })

  test("the fixture organisation records are exactly FIXTURE_PROJECT_IDS", () => {
    const organisation = getModuleDefinition({
      workspaceId: "configure",
      moduleId: "organization",
    })
    assert.ok(organisation, "configure.organization is a registered module")
    assert.deepEqual(
      projectRecordsOf(organisation.records).map((project) => project.id),
      Object.values(FIXTURE_PROJECT_IDS),
    )
  })
})

describe("pinnedProjectId", () => {
  test("every permitted project pins nothing", () => {
    assert.equal(pinnedProjectId(ALL_PROJECTS), null)
  })

  test("a project scope pins that project record's id", () => {
    assert.equal(pinnedProjectId(FIXTURE_PROJECT_IDS.cairo), FIXTURE_PROJECT_IDS.cairo)
  })
})

describe("isInProjectScope", () => {
  const cairoScope: ProjectScope = FIXTURE_PROJECT_IDS.cairo
  const copenhagenScope: ProjectScope = FIXTURE_PROJECT_IDS.copenhagen

  test("a record of the selected project is shown", () => {
    assert.equal(isInProjectScope(scopedTo(cairo.id), cairoScope), true)
  })

  test("a record of another project is not, whichever project it is", () => {
    // Cairo's calendars used to leak into the Copenhagen scope because the
    // union did not know the id; now the comparison is against the record.
    assert.equal(isInProjectScope(scopedTo(cairo.id), copenhagenScope), false)
    assert.equal(isInProjectScope(scopedTo(harbor.id), cairoScope), false)
    assert.equal(isInProjectScope(scopedTo(created.id), copenhagenScope), false)
    assert.equal(isInProjectScope(scopedTo(created.id), created.id as ProjectScope), true)
  })

  test("a company-wide record — no project, or several — is shown in every scope", () => {
    assert.equal(isInProjectScope(record("r", "R"), cairoScope), true)
    assert.equal(isInProjectScope(scopedTo(), cairoScope), true)
    assert.equal(isInProjectScope(scopedTo(copenhagen.id, harbor.id), cairoScope), true)
  })

  test("every permitted project shows everything", () => {
    assert.equal(isInProjectScope(scopedTo(harbor.id), ALL_PROJECTS), true)
  })
})

describe("selectedProjectIds", () => {
  test("a chosen project scopes the record, whichever scope the workspace runs in", () => {
    assert.deepEqual(
      selectedProjectIds(FIXTURE_PROJECT_IDS.copenhagen, { projectId: cairo.id }, projects),
      [cairo.id],
    )
    assert.deepEqual(
      selectedProjectIds(ALL_PROJECTS, { projectId: created.id }, projects),
      [created.id],
    )
  })

  test("a value that is not a project record id is ignored", () => {
    assert.deepEqual(
      selectedProjectIds(FIXTURE_PROJECT_IDS.harbor, { projectId: "" }, projects),
      [harbor.id],
    )
    assert.deepEqual(
      selectedProjectIds(FIXTURE_PROJECT_IDS.harbor, { projectId: company.id }, projects),
      [harbor.id],
    )
    assert.deepEqual(
      selectedProjectIds(FIXTURE_PROJECT_IDS.harbor, { projectId: true }, projects),
      [harbor.id],
    )
  })

  test("a project scope stamps that project", () => {
    assert.deepEqual(selectedProjectIds(FIXTURE_PROJECT_IDS.cairo, {}, projects), [cairo.id])
  })

  test("every permitted project stamps every project record, created ones included", () => {
    assert.deepEqual(
      selectedProjectIds(ALL_PROJECTS, {}, projects),
      [copenhagen.id, harbor.id, cairo.id, created.id],
    )
  })
})

describe("projectScopeLabel", () => {
  test("one project reads as its record's name", () => {
    assert.equal(projectScopeLabel([cairo.id], projects), "Cairo Operations")
    assert.equal(projectScopeLabel([created.id], projects), "Aarhus North")
  })

  test("a project no record names reads as its id, never as another project", () => {
    assert.equal(projectScopeLabel(["project-unknown"], projects), "project-unknown")
  })

  test("several projects read as all permitted projects", () => {
    assert.equal(
      projectScopeLabel([copenhagen.id, harbor.id], projects),
      "All permitted projects",
    )
  })

  test("no project reads as nothing", () => {
    assert.equal(projectScopeLabel([], projects), "")
  })
})
