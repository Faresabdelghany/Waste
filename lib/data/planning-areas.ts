/**
 * Areas & Zones — the Settings-managed planning-geography module (D37,
 * docs/new-changes/DECISIONS.md; moved from the Plan workspace 2026-09-03).
 *
 * Planning areas stay business records in the shared record store under
 * `configure.areas` so Route Schemes, containers, and Service Areas keep
 * referencing them; only the management surface moved to Settings. This
 * module is the one place that knows where the records live, how a stored
 * record seeds the edit form, how its purpose and table row derive, and the
 * record shape the Settings pane writes on create and edit.
 */

import { slugify } from "@/lib/utils"

import { settingsModuleDomains } from "./business-domain"
import { deriveFormRecord } from "./business-form-records"
import { getBusinessFormSchema } from "./business-form-schemas"
import type {
  BusinessFormField,
  BusinessFormOption,
  BusinessFormSchema,
  BusinessFormValues,
} from "./business-form-types"
import {
  FIXTURE_COMPANY_ID,
  FIXTURE_PROJECT_IDS,
  getModuleDefinition,
  type BusinessRecord,
  type ModuleDefinition,
  type ModuleLocation,
} from "./business-modules"

const areasDomain = settingsModuleDomains.find(
  (module) => module.key === "configure.areas",
)
if (!areasDomain) {
  throw new Error("configure.areas is missing from settingsModuleDomains")
}

/** Where planning-area records live — every consumer resolves through this. */
export const PLANNING_AREAS_MODULE: ModuleLocation = {
  workspaceId: areasDomain.workspaceId,
  moduleId: areasDomain.moduleId,
}

/** The SettingsDialog pane that manages the module. */
export const PLANNING_AREAS_SETTINGS_PANE_ID = areasDomain.settingsPaneId

export type PlanningAreaPurpose =
  | "route-planning"
  | "service-operations"
  | "notification"

const PURPOSES: ReadonlySet<string> = new Set<PlanningAreaPurpose>([
  "route-planning",
  "service-operations",
  "notification",
])

/**
 * Fixture contexts read "<purpose display> · <project>" ("Planning area ·
 * Copenhagen Central"); the display words map back onto the typed purpose.
 */
const CONTEXT_PURPOSES: Readonly<Record<string, PlanningAreaPurpose>> = {
  "planning area": "route-planning",
  "route planning": "route-planning",
  "service operations": "service-operations",
  "notification zone": "notification",
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function stringValue(record: BusinessRecord, fieldId: string): string {
  const value = record.submittedValues?.[fieldId]
  return typeof value === "string" ? value.trim() : ""
}

function isoDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && ISO_DATE.test(trimmed) ? trimmed : undefined
}

/** The module definition (label, copy, lifecycle, fixtures) — guaranteed by the registry. */
export function planningAreasModule(): ModuleDefinition {
  const module = getModuleDefinition(PLANNING_AREAS_MODULE)
  if (!module) throw new Error("configure.areas module is not registered")
  return module
}

/** The create/edit form for planning areas — guaranteed by the schema gate. */
export function planningAreaSchema(): BusinessFormSchema {
  const schema = getBusinessFormSchema(
    PLANNING_AREAS_MODULE.workspaceId,
    PLANNING_AREAS_MODULE.moduleId,
  )
  if (!schema) throw new Error("configure.areas has no form schema")
  return schema
}

function schemaFields(schema: BusinessFormSchema): BusinessFormField[] {
  return schema.sections.flatMap((section) => section.fields)
}

/** The purpose options the form offers — value is the typed purpose, label the display. */
export function planningAreaPurposeOptions(): readonly BusinessFormOption[] {
  return (
    schemaFields(planningAreaSchema()).find((field) => field.id === "purpose")
      ?.options ?? []
  )
}

function purposeLabel(purpose: PlanningAreaPurpose | undefined): string | undefined {
  if (!purpose) return undefined
  return planningAreaPurposeOptions().find((option) => option.value === purpose)?.label
}

/**
 * The area's purpose: the typed submitted value, else the "Area purpose"
 * display fact matched against the form's option labels, else the fixture
 * context prefix. Undefined when none of those resolve.
 */
export function planningAreaPurpose(
  record: BusinessRecord,
): PlanningAreaPurpose | undefined {
  const typed = stringValue(record, "purpose")
  if (PURPOSES.has(typed)) return typed as PlanningAreaPurpose

  const fact = record.facts["Area purpose"]?.trim().toLowerCase()
  if (fact) {
    const option = planningAreaPurposeOptions().find(
      (candidate) => candidate.label.toLowerCase() === fact,
    )
    if (option && PURPOSES.has(option.value)) {
      return option.value as PlanningAreaPurpose
    }
  }

  const contextHead = record.context.split("·")[0]?.trim().toLowerCase() ?? ""
  return CONTEXT_PURPOSES[contextHead]
}

/**
 * Seeds the edit form from a stored record: every typed submitted value the
 * form knows wins (booleans included), then fixture display facts fill the
 * gaps — the name, the `Code` fact as the area reference, a single project
 * scope, the context purpose, and ISO-dated effective facts. A required
 * effective-from with no ISO source falls back to today so the form is not
 * born invalid; an optional effective-to is never invented.
 */
export function planningAreaFormValues(
  record: BusinessRecord,
  today: string,
): BusinessFormValues {
  const fields = schemaFields(planningAreaSchema())
  const fieldIds = new Set(fields.map((field) => field.id))
  const values: BusinessFormValues = {}

  for (const [key, value] of Object.entries(record.submittedValues ?? {})) {
    if (!fieldIds.has(key)) continue
    if (typeof value === "string" ? value.trim() !== "" : typeof value === "boolean") {
      values[key] = value
    }
  }

  const seed = (fieldId: string, value: string | undefined) => {
    if (fieldId in values || !fieldIds.has(fieldId) || !value) return
    values[fieldId] = value
  }
  seed("areaName", record.name)
  seed("areaCode", record.facts["Area reference"] ?? record.facts.Code)
  seed(
    "projectId",
    record.projectIds?.length === 1 ? record.projectIds[0] : undefined,
  )
  seed("purpose", planningAreaPurpose(record))
  seed(
    "effectiveFrom",
    isoDate(record.facts["Effective from"] ?? record.facts.Effective) ?? today,
  )
  seed("effectiveTo", isoDate(record.facts["Effective to"]))

  return values
}

export type PlanningAreaLookups = {
  /** Display name of a project (configure.organization record). */
  projectName: (projectId: string) => string | undefined
  /** Display name of any related record, by relation target and id. */
  recordName: (relation: ModuleLocation, recordId: string) => string | undefined
}

export type PlanningAreaTableRow = {
  code: string
  purpose: string
  project: string
  effective: string
  coverage: string
  status: string
}

/** The Settings table cells for one planning area. */
export function planningAreaTableRow(
  record: BusinessRecord,
  lookups: Pick<PlanningAreaLookups, "projectName">,
): PlanningAreaTableRow {
  const projectIds = record.projectIds ?? []
  const from = isoDate(stringValue(record, "effectiveFrom"))
  const to = isoDate(stringValue(record, "effectiveTo"))
  const fixtureEffective = (
    record.facts["Effective from"] ?? record.facts.Effective
  )?.trim()

  return {
    code:
      stringValue(record, "areaCode") ||
      record.facts["Area reference"] ||
      record.facts.Code ||
      "—",
    purpose: purposeLabel(planningAreaPurpose(record)) ?? "—",
    project:
      projectIds.length > 1
        ? "All projects"
        : projectIds.length === 1
          ? lookups.projectName(projectIds[0]) ?? projectIds[0]
          : "—",
    effective: from ? (to ? `${from} → ${to}` : `${from} →`) : fixtureEffective || "—",
    coverage: record.value || "—",
    status: record.status,
  }
}

/* --------------------------------- writes --------------------------------- */

export type PlanningAreaWriteContext = {
  /** Who is saving — stamped as the creator. */
  actorName: string
  /** Milliseconds since the epoch — the id suffix. */
  now: number
  lookups: PlanningAreaLookups
}

/**
 * Fixture display facts that a form field supersedes: once the field has a
 * typed value the alias would sit beside it saying something else, so an edit
 * drops the alias. Reads keep both as fallbacks for never-edited fixtures.
 */
const FIXTURE_FACT_ALIASES: Readonly<Record<string, string>> = {
  Code: "areaCode",
  Effective: "effectiveFrom",
}

type FormDerivation = {
  facts: Record<string, string>
  relationRefs: NonNullable<BusinessRecord["relationRefs"]>
  context: string
  name: string
  projectIds: string[]
}

/**
 * The shared label-keyed derivation (lib/data/business-form-records.ts) with
 * this module's lookups, minus the name field's own fact — the record's name
 * already carries it — plus the project scope.
 */
function deriveFromForm(
  schema: BusinessFormSchema,
  values: BusinessFormValues,
  lookups: PlanningAreaLookups,
): FormDerivation {
  const derived = deriveFormRecord(schema, values, {
    relationRecordName: (field, recordId) =>
      field.relation ? lookups.recordName(field.relation, recordId) : undefined,
  })
  const nameField = schemaFields(schema).find((field) => field.id === schema.nameField)
  if (nameField) delete derived.facts[nameField.label]
  const projectId = typeof values.projectId === "string" ? values.projectId.trim() : ""

  return {
    facts: derived.facts,
    relationRefs: derived.relationRefs,
    context: derived.contextValues.join(" · "),
    name: derived.nameValue.trim(),
    // A chosen project scopes the record; no project means every project.
    projectIds: projectId
      ? [projectId]
      : [FIXTURE_PROJECT_IDS.copenhagen, FIXTURE_PROJECT_IDS.harbor],
  }
}

/**
 * A new planning area from the create form — the business-record shape the
 * Plan workspace's generic create path produced before the move (id from
 * module and record kind, label-keyed facts, typed relations, first lifecycle
 * state, company scope), sourced from Settings. Coverage is measured from
 * validated geometry, which nothing computes yet, so it shows "—".
 */
export function createPlanningAreaRecord(
  values: BusinessFormValues,
  context: PlanningAreaWriteContext,
): BusinessRecord {
  const schema = planningAreaSchema()
  const module = planningAreasModule()
  const derived = deriveFromForm(schema, values, context.lookups)

  return {
    id: `${module.id}-${slugify(schema.recordKind)}-${context.now}`,
    name: derived.name || `${schema.recordKind} · ${context.now}`,
    context: derived.context,
    status: module.lifecycle[0] ?? "Draft",
    owner: context.actorName,
    value: "—",
    updated: "Now",
    description: schema.description,
    facts: {
      "Record kind": schema.recordKind,
      "Submitted by": context.actorName,
      ...derived.facts,
    },
    related: derived.relationRefs.map((relation) => relation.label),
    source: "Settings",
    freshness: "Now",
    allowedTransitions: module.lifecycle.slice(1, 3),
    companyId: FIXTURE_COMPANY_ID,
    projectIds: derived.projectIds,
    recordKind: schema.recordKind,
    submittedValues: values,
    relationRefs: derived.relationRefs,
  }
}

/**
 * An edited planning area: the form's facts layer over the stored ones — a
 * cleared field drops its stale fact, and a fixture alias fact (`Code`,
 * `Effective`) goes once its field carries the value — the name and context
 * follow the form, typed values merge, relations and project scope are
 * rebuilt, and status, owner, coverage and related chips stay.
 */
export function updatePlanningAreaRecord(
  existing: BusinessRecord,
  values: BusinessFormValues,
  lookups: PlanningAreaLookups,
): BusinessRecord {
  const schema = planningAreaSchema()
  const derived = deriveFromForm(schema, values, lookups)

  const facts = { ...existing.facts }
  for (const field of schemaFields(schema)) {
    const value = values[field.id]
    if (value === undefined || value === "") delete facts[field.label]
  }
  for (const [alias, fieldId] of Object.entries(FIXTURE_FACT_ALIASES)) {
    const value = values[fieldId]
    if (value !== undefined && value !== "") delete facts[alias]
  }

  return {
    ...existing,
    name: derived.name || existing.name,
    context: derived.context || existing.context,
    updated: "Now",
    freshness: "Now",
    facts: { ...facts, ...derived.facts },
    submittedValues: { ...existing.submittedValues, ...values },
    relationRefs: derived.relationRefs,
    projectIds: derived.projectIds,
  }
}
