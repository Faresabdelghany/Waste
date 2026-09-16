/**
 * Collection Calendars — the Settings-managed holiday-calendar module (moved
 * from the Plan workspace 2026-09-16, when Plan became Map Planning).
 *
 * Calendar records stay business records in the shared record store under
 * `configure.calendars` so route generation, the Guided Setup wizard, and
 * Plan Ahead keep reading the project's dated holidays; only the management
 * surface moved to Settings. This module is the one place that knows where
 * the records live, how a stored record seeds the edit form, and the record
 * shape the Settings pane writes on create and edit.
 */

import { slugify } from "@/lib/utils"

import { settingsModuleDomains } from "./business-domain"
import { deriveFormRecord } from "./business-form-records"
import { getBusinessFormSchema } from "./business-form-schemas"
import type {
  BusinessFormField,
  BusinessFormSchema,
  BusinessFormValues,
} from "./business-form-types"
import {
  FIXTURE_COMPANY_ID,
  getModuleDefinition,
  type BusinessRecord,
  type ModuleDefinition,
  type ModuleLocation,
} from "./business-modules"

const calendarsDomain = settingsModuleDomains.find(
  (module) => module.key === "configure.calendars",
)
if (!calendarsDomain) {
  throw new Error("configure.calendars is missing from settingsModuleDomains")
}

/** Where collection-calendar records live — every consumer resolves through this. */
export const COLLECTION_CALENDARS_MODULE: ModuleLocation = {
  workspaceId: calendarsDomain.workspaceId,
  moduleId: calendarsDomain.moduleId,
}

/** The SettingsDialog pane that manages the module. */
export const COLLECTION_CALENDARS_SETTINGS_PANE_ID = calendarsDomain.settingsPaneId

/** The module definition (label, copy, lifecycle, fixtures) — guaranteed by the registry. */
export function collectionCalendarsModule(): ModuleDefinition {
  const module = getModuleDefinition(COLLECTION_CALENDARS_MODULE)
  if (!module) throw new Error("configure.calendars module is not registered")
  return module
}

/** The create/edit form for collection calendars — guaranteed by the schema gate. */
export function collectionCalendarSchema(): BusinessFormSchema {
  const schema = getBusinessFormSchema(
    COLLECTION_CALENDARS_MODULE.workspaceId,
    COLLECTION_CALENDARS_MODULE.moduleId,
  )
  if (!schema) throw new Error("configure.calendars has no form schema")
  return schema
}

function schemaFields(schema: BusinessFormSchema): BusinessFormField[] {
  return schema.sections.flatMap((section) => section.fields)
}

/**
 * Seeds the edit form from a stored record: every typed submitted value the
 * form knows wins, then the record's own scope fills the gaps — the name and
 * a single project scope. Fixture calendars carry their structured values
 * (holiday dates, validity, week start, time zone) as submittedValues already,
 * so nothing is re-derived from display facts.
 */
export function collectionCalendarFormValues(record: BusinessRecord): BusinessFormValues {
  const fieldIds = new Set(schemaFields(collectionCalendarSchema()).map((field) => field.id))
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
  seed("calendarName", record.name)
  seed("projectId", record.projectIds?.length === 1 ? record.projectIds[0] : undefined)

  return values
}

export type CollectionCalendarLookups = {
  /** Display name of a project (configure.organization record). */
  projectName: (projectId: string) => string | undefined
  /** Display name of any related record, by relation target and id. */
  recordName: (relation: ModuleLocation, recordId: string) => string | undefined
}

export type CollectionCalendarWriteContext = {
  /** Who is saving — stamped as the creator. */
  actorName: string
  /** Milliseconds since the epoch — the id suffix. */
  now: number
  lookups: CollectionCalendarLookups
}

/**
 * Fixture display facts that a form field supersedes: once the field has a
 * typed value the alias would sit beside it saying something else, so an edit
 * drops the alias. Reads keep both as fallbacks for never-edited fixtures.
 */
const FIXTURE_FACT_ALIASES: Readonly<Record<string, string>> = {
  WeekStart: "weekStart",
  Timezone: "timezone",
  Validity: "validFrom",
  Holidays: "holidayDates",
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
  lookups: CollectionCalendarLookups,
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
    // Calendars are project-scoped (D22): the chosen project is the scope.
    projectIds: projectId ? [projectId] : [],
  }
}

/**
 * A new collection calendar from the create form — the business-record shape
 * the Plan workspace's generic create path produced before the move (id from
 * module and record kind, label-keyed facts, typed relations, first lifecycle
 * state, company scope), sourced from Settings. The list's Holidays / Next
 * holiday cells derive from the typed values at render time (issue #27), so
 * `value` starts empty.
 */
export function createCollectionCalendarRecord(
  values: BusinessFormValues,
  context: CollectionCalendarWriteContext,
): BusinessRecord {
  const schema = collectionCalendarSchema()
  const module = collectionCalendarsModule()
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
 * An edited collection calendar: the form's facts layer over the stored ones —
 * a cleared field drops its stale fact, and a fixture alias fact goes once its
 * field carries the value — the name and context follow the form, typed values
 * merge, relations and project scope are rebuilt, and status, owner, and
 * related chips stay.
 */
export function updateCollectionCalendarRecord(
  existing: BusinessRecord,
  values: BusinessFormValues,
  lookups: CollectionCalendarLookups,
): BusinessRecord {
  const schema = collectionCalendarSchema()
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
    projectIds: derived.projectIds.length > 0 ? derived.projectIds : existing.projectIds,
  }
}
