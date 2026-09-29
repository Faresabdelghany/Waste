// The operational master data as the web keeps it (Issue #176, slice 2 of
// #81): the `configure.master` module — the prototype's "Operational Master
// Data", whose two fixture records are coarse master-data sets that only the
// fixture pickers point at — becomes, on the API, the company's own
// catalogue vocabulary in four kinds: waste fractions, container types,
// service frequencies and vehicle types (`@waste/contracts/catalogue`,
// `vehicle-types`). Settings › Operations › Master data reads and writes the
// module through the record store (components/settings/master-data-settings.tsx),
// and the adapters that speak to the API are lib/api/records/master-data.ts.
//
// One rule says which kind a record is, and every side reads it:
// `masterDataKindOf` (master-data-kinds.ts) — the id's prefix first
// (`fraction-…`, `container-type-…`, `frequency-…`, `vehicle-type-…`: what
// the adapters mint from the server's id and the pane mints for a new row),
// then the typed `kind` the pane's forms write. The adapters' `owns` is that
// rule, so is the filter the generic workspace applies to a picker that
// points at the module, and so is the link to a row: a renamed row stays in
// its list, and a fixture master-data set, which is of no kind, keeps its
// old home under Operations setup.
//
// The rules a write is held to are spelled here once — a key's shape, a
// count, the contract's one cadence rule in the contract's own sentence — and
// read twice: by the pane's form, inline at the field before a submit, and by
// the adapter, which refuses the same body by name before the API sees it.
//
// The four forms are the pane's own, not the generic registry's: the
// registry's `configure.master` schema stays disabled, since the prototype
// never had a create button for the module and fixture mode gains none. A
// key (a fraction's, a vehicle type's) is set once and a frequency stays in
// its project, so the edit forms hold those read-only; what a person may
// change is what the wire patches.
import type { BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import { splitMultiValue } from "./business-form-records"
import { settingsModuleDomains } from "./business-domain"
import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "./business-modules"
import { MASTER_DATA_KIND_DETAILS, MASTER_DATA_KIND_KEY, masterDataKindOf, type MasterDataKind } from "./master-data-kinds"

export {
  MASTER_DATA_KINDS,
  MASTER_DATA_KIND_KEY,
  MASTER_DATA_KIND_DETAILS,
  isMasterDataKind,
  masterDataKindOf,
  masterDataKindForField,
  type MasterDataKind,
  type MasterDataKindDetails,
} from "./master-data-kinds"

const masterDomain = settingsModuleDomains.find((module) => module.moduleId === "master")
if (!masterDomain) throw new Error("business-domain lists no settings domain for configure.master")

/** A record's typed values, as the registry keeps them. */
type SubmittedValues = NonNullable<BusinessRecord["submittedValues"]>

/** Where the master data lives — the one seam callers resolve the module through, never the pair spelled by hand. */
export const MASTER_DATA_MODULE: ModuleLocation = {
  workspaceId: masterDomain.workspaceId,
  moduleId: masterDomain.moduleId,
}

// ---------------------------------------------------------------------------
// The rules a write is held to, spelled once
// ---------------------------------------------------------------------------

/** The contracts' key shape (`Slug`, text.ts): a lowercase slug of at most 50 characters. */
export const KEY_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const KEY_MAX = 50
export const KEY_REFUSAL = "A key is a lowercase slug of letters, digits and single hyphens, such as hard-plastic"
export const isKey = (value: string | undefined): value is string => value !== undefined && value.length <= KEY_MAX && KEY_SHAPE.test(value)

/** The contract's one cadence sentence (`@waste/contracts/catalogue`, `ONE_CADENCE`), quoted since the contracts reach the bundle as types alone; the tests hold the two equal. */
export const ONE_CADENCE = "Give collectionsPerWeek with at most one of weeksBetween and daysBetween, or none of the three (on demand)"

export const VOLUME_REFUSAL = "A volume is a whole number of litres"

export const COUNT_LABELS = { collectionsPerWeek: "Collections per week", weeksBetween: "Weeks between", daysBetween: "Days between" } as const
export type CountKey = keyof typeof COUNT_LABELS
const COUNT_KEYS = Object.keys(COUNT_LABELS) as CountKey[]
export const countRefusal = (key: CountKey) => `${COUNT_LABELS[key]} is a whole number, 1 or more`

/** `A waste fraction needs a name`. */
export const nameRefusal = (kind: MasterDataKind) => `A ${MASTER_DATA_KIND_DETAILS[kind].label.toLowerCase()} needs a name`

/** `The key is set once: a waste fraction that needs another key is another waste fraction`. */
export const keyMovedRefusal = (kind: MasterDataKind) => {
  const lower = MASTER_DATA_KIND_DETAILS[kind].label.toLowerCase()
  return `The key is set once: a ${lower} that needs another key is another ${lower}`
}

/** The contract's own rule over the three numbers as stored (`serviceFrequencyShape`). */
export function cadenceHolds({ collectionsPerWeek, weeksBetween, daysBetween }: Pick<MasterDataFields, "collectionsPerWeek" | "weeksBetween" | "daysBetween">): boolean {
  if (weeksBetween != null && daysBetween != null) return false
  return collectionsPerWeek != null || (weeksBetween == null && daysBetween == null)
}

// ---------------------------------------------------------------------------
// The fields of a row, typed
// ---------------------------------------------------------------------------

/** What a row of any kind carries, typed; a field another kind has no use for is absent. A count that is no count is NaN, refused by name. */
export type MasterDataFields = {
  kind: MasterDataKind
  name: string
  /** A fraction's or a vehicle type's stable slug. */
  key?: string
  /** A container type's volume; null where nobody recorded one. */
  volumeLitres?: number | null
  /** A frequency's project, by web id. */
  projectId?: string
  description?: string | null
  collectionsPerWeek?: number | null
  weeksBetween?: number | null
  daysBetween?: number | null
  /** A vehicle type's container types, by web id. */
  containerTypeIds?: string[]
}

/** The names a row's facts show for the rows it names. */
export type MasterDataLookups = {
  projectName: (projectId: string) => string | undefined
  containerTypeName: (containerTypeId: string) => string | undefined
}

/** The form's own field ids per kind: what the typed values carry, in the form's order. */
const KIND_FIELD_IDS: Readonly<Record<MasterDataKind, readonly string[]>> = {
  "waste-fraction": ["name", "key"],
  "container-type": ["name", "volumeLitres"],
  "service-frequency": ["name", "projectId", "description", "collectionsPerWeek", "weeksBetween", "daysBetween"],
  "vehicle-type": ["name", "key", "description", "containerTypeIds"],
}

const text = (values: BusinessFormValues | SubmittedValues | undefined, key: string): string | undefined => {
  const value = values?.[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** A form's number: null for blank, the number for a whole positive one (`240`, `240.0`), NaN for anything else. */
const count = (values: BusinessFormValues | SubmittedValues | undefined, key: string): number | null => {
  const value = text(values, key)
  if (value === undefined) return null
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : Number.NaN
}

/** The typed fields a form's values, or a record's typed values, spell for a kind. */
export function masterDataFieldsOf(kind: MasterDataKind, values: BusinessFormValues | SubmittedValues | undefined): MasterDataFields {
  const name = text(values, "name") ?? ""
  switch (kind) {
    case "waste-fraction":
      return { kind, name, key: text(values, "key") ?? "" }
    case "container-type":
      return { kind, name, volumeLitres: count(values, "volumeLitres") }
    case "service-frequency":
      return {
        kind,
        name,
        projectId: text(values, "projectId") ?? "",
        description: text(values, "description") ?? null,
        collectionsPerWeek: count(values, "collectionsPerWeek"),
        weeksBetween: count(values, "weeksBetween"),
        daysBetween: count(values, "daysBetween"),
      }
    case "vehicle-type": {
      const ids = text(values, "containerTypeIds")
      return { kind, name, key: text(values, "key") ?? "", description: text(values, "description") ?? null, containerTypeIds: ids === undefined ? [] : splitMultiValue(ids) }
    }
  }
}

/** The typed values a row keeps: the kind, then the form's own text for the kind's fields, trimmed, blanks left out. */
export function masterDataTypedValues(kind: MasterDataKind, values: BusinessFormValues | SubmittedValues | undefined): SubmittedValues {
  const typed: SubmittedValues = { [MASTER_DATA_KIND_KEY]: kind }
  for (const key of KIND_FIELD_IDS[kind]) {
    const value = text(values, key)
    if (value !== undefined) typed[key] = value
  }
  return typed
}

/**
 * What the form's values break, by field, in the words the adapter refuses
 * the same body with — the pane shows them at the field before a submit.
 * The project's existence and a container type's are the store's to judge.
 */
export function masterDataFieldErrors(kind: MasterDataKind, values: BusinessFormValues | SubmittedValues | undefined): Record<string, string> {
  const fields = masterDataFieldsOf(kind, values)
  const errors: Record<string, string> = {}
  if (!fields.name) errors.name = nameRefusal(kind)
  if ((kind === "waste-fraction" || kind === "vehicle-type") && !isKey(fields.key)) errors.key = KEY_REFUSAL
  if (kind === "container-type" && Number.isNaN(fields.volumeLitres)) errors.volumeLitres = VOLUME_REFUSAL
  if (kind === "service-frequency") {
    if (!fields.projectId) errors.projectId = "Pick a project"
    for (const key of COUNT_KEYS) if (Number.isNaN(fields[key])) errors[key] = countRefusal(key)
    if (!COUNT_KEYS.some((key) => key in errors) && !cadenceHolds(fields)) errors.collectionsPerWeek = ONE_CADENCE
  }
  return errors
}

const litres = new Intl.NumberFormat("en-GB")

/** `240 L`, the way the registry's container type names spell a volume. */
export const volumeLabel = (volumeLitres: number) => `${litres.format(volumeLitres)} L`

/**
 * The cadence three numbers spell, the way the contract explains them: no
 * rate is on demand; one every n weeks is every week or every n weeks, and
 * more than one so many collections a week or every n weeks; a rate with
 * neither interval is once a month at one, else so many a week; a days
 * interval says how far apart they fall.
 */
export function cadenceLabel({ collectionsPerWeek, weeksBetween, daysBetween }: Pick<MasterDataFields, "collectionsPerWeek" | "weeksBetween" | "daysBetween">): string {
  const rate = collectionsPerWeek ?? null
  if (rate === null || Number.isNaN(rate)) return "On demand"
  const perWeek = rate === 1 ? undefined : `${rate} collections`
  if (weeksBetween != null) {
    if (weeksBetween === 1) return perWeek ? `${perWeek} a week` : "Every week"
    return perWeek ? `${perWeek} every ${weeksBetween} weeks` : `Every ${weeksBetween} weeks`
  }
  if (daysBetween != null) return perWeek ? `${perWeek} a week, every ${daysBetween} days` : `Every ${daysBetween} days`
  return perWeek ? `${perWeek} a week` : "Once a month"
}

/** What the fields show as a record: its context line, headline value, facts and project scope. */
export function presentMasterData(fields: MasterDataFields, lookups: MasterDataLookups): Pick<BusinessRecord, "context" | "value" | "facts" | "projectIds" | "recordKind"> {
  const details = MASTER_DATA_KIND_DETAILS[fields.kind]
  const base = { recordKind: details.recordKind, projectIds: [] as string[] }
  switch (fields.kind) {
    case "waste-fraction": {
      const key = fields.key ?? ""
      return { ...base, context: `${details.label} · ${key}`, value: key, facts: { Kind: details.label, Key: key } }
    }
    case "container-type": {
      const volume = fields.volumeLitres ?? null
      const shown = volume === null || Number.isNaN(volume) ? undefined : volumeLabel(volume)
      return {
        ...base,
        context: `${details.label} · ${shown ?? "volume not recorded"}`,
        value: shown ?? "—",
        facts: { Kind: details.label, ...(shown === undefined ? {} : { Volume: shown }) },
      }
    }
    case "service-frequency": {
      const projectId = fields.projectId ?? ""
      const project = (projectId && lookups.projectName(projectId)) || "Project"
      const cadence = cadenceLabel(fields)
      return {
        ...base,
        projectIds: projectId ? [projectId] : [],
        context: `${details.label} · ${project}`,
        value: cadence,
        facts: { Kind: details.label, Project: project, Cadence: cadence, ...(fields.description ? { Description: fields.description } : {}) },
      }
    }
    case "vehicle-type": {
      const key = fields.key ?? ""
      const ids = fields.containerTypeIds ?? []
      const names = ids.map((id) => lookups.containerTypeName(id) ?? id)
      return {
        ...base,
        context: `${details.label} · ${key}`,
        value: ids.length === 0 ? "No container types" : `${ids.length} container type${ids.length === 1 ? "" : "s"}`,
        facts: { Kind: details.label, Key: key, ...(fields.description ? { Description: fields.description } : {}), ...(names.length === 0 ? {} : { "Container types": names.join(", ") }) },
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

/** The create form of one kind: the pane's own, keyed to the module. The dialog shows no field guidance on a create form, so the rules speak inline through `masterDataFieldErrors`. */
export function masterDataSchema(kind: MasterDataKind): BusinessFormSchema {
  const details = MASTER_DATA_KIND_DETAILS[kind]
  const lower = details.label.toLowerCase()
  const fields: BusinessFormSchema["sections"][number]["fields"] = [
    { id: "name", label: "Name", type: "text", required: true },
    ...(kind === "waste-fraction" || kind === "vehicle-type" ? [{ id: "key", label: "Key", type: "text" as const, required: true, placeholder: kind === "waste-fraction" ? "hard-plastic" : "rear-loader" }] : []),
    ...(kind === "container-type" ? [{ id: "volumeLitres", label: "Volume", type: "number" as const, min: 1, unit: "L" }] : []),
    ...(kind === "service-frequency"
      ? [
          { id: "projectId", label: "Project", type: "select" as const, required: true, relation: { workspaceId: "configure" as const, moduleId: "organization" } },
          { id: "description", label: "Description", type: "textarea" as const },
          { id: "collectionsPerWeek", label: "Collections per week", type: "number" as const, min: 1, placeholder: "Blank is on demand" },
          { id: "weeksBetween", label: "Weeks between", type: "number" as const, min: 1, placeholder: "Once a week or less often" },
          { id: "daysBetween", label: "Days between", type: "number" as const, min: 1, placeholder: "More often than once a week" },
        ]
      : []),
    ...(kind === "vehicle-type"
      ? [
          { id: "description", label: "Description", type: "textarea" as const },
          { id: "containerTypeIds", label: "Container types", type: "multiselect" as const, relation: MASTER_DATA_MODULE },
        ]
      : []),
  ]
  return {
    key: `${MASTER_DATA_MODULE.workspaceId}.${MASTER_DATA_MODULE.moduleId}`,
    mode: "create",
    recordKind: details.recordKind,
    title: `Create ${lower}`,
    description: `A ${lower} of the company's own vocabulary${kind === "service-frequency" ? ", offered on one project" : ""}.`,
    submitLabel: `Create ${lower}`,
    nameField: "name",
    contextFieldIds: kind === "service-frequency" ? ["projectId"] : kind === "container-type" ? ["volumeLitres"] : ["key"],
    sections: [{ id: "identity", title: details.label, fields }],
    execution: { kind: "create-record", initialStatus: "Effective", completionMessage: `${details.label} created.` },
  }
}

/** The edit form of one kind: the create form, with what the wire never patches held read-only. */
export function masterDataEditSchema(kind: MasterDataKind): BusinessFormSchema {
  const schema = masterDataSchema(kind)
  const lower = MASTER_DATA_KIND_DETAILS[kind].label.toLowerCase()
  return {
    ...schema,
    title: `Edit ${lower}`,
    description: `Update this ${lower}. Its key and its project do not move.`,
    submitLabel: "Save changes",
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (field.id === "key" || field.id === "projectId" ? { ...field, readOnly: true } : field)),
    })),
  }
}

/** The values the edit form opens with: the record's typed values, the kind left out since the tab is the kind. */
export function masterDataFormValues(record: BusinessRecord): BusinessFormValues {
  const values: BusinessFormValues = {}
  for (const [key, value] of Object.entries(record.submittedValues ?? {})) {
    if (key === MASTER_DATA_KIND_KEY) continue
    if (typeof value === "string" && value.trim() !== "") values[key] = value
  }
  return values
}

// ---------------------------------------------------------------------------
// The records the pane writes
// ---------------------------------------------------------------------------

export type MasterDataWriteContext = {
  /** Who is saving — stamped as the creator. */
  actorName: string
  /** Milliseconds since the epoch — the id suffix. */
  now: number
  lookups: MasterDataLookups
}

/** A new row from the create form: minted under its kind's prefix, in force, sourced from Settings. */
export function createMasterDataRecord(kind: MasterDataKind, values: BusinessFormValues, context: MasterDataWriteContext): BusinessRecord {
  const details = MASTER_DATA_KIND_DETAILS[kind]
  const fields = masterDataFieldsOf(kind, values)
  const shown = presentMasterData(fields, context.lookups)
  return {
    id: `${details.prefix}-${context.now}`,
    name: fields.name || `${details.label} · ${context.now}`,
    context: shown.context,
    status: "Effective",
    owner: context.actorName,
    value: shown.value,
    updated: "Now",
    description: `${details.label} of the company's master data.`,
    facts: { "Record kind": details.recordKind, "Submitted by": context.actorName, ...shown.facts },
    related: [],
    source: "Settings",
    freshness: "Now",
    companyId: FIXTURE_COMPANY_ID,
    projectIds: shown.projectIds,
    recordKind: shown.recordKind,
    submittedValues: masterDataTypedValues(kind, values),
  }
}

/** An edited row: its identity and stamps kept, the form's values over the typed ones, the presentation rebuilt from them. */
export function updateMasterDataRecord(existing: BusinessRecord, values: BusinessFormValues, lookups: MasterDataLookups): BusinessRecord {
  const kind = masterDataKindOf(existing)
  if (kind === null) return existing
  const merged = { ...existing.submittedValues, ...values }
  const fields = masterDataFieldsOf(kind, merged)
  const shown = presentMasterData(fields, lookups)
  const facts = { ...existing.facts }
  for (const key of ["Key", "Volume", "Project", "Cadence", "Description", "Container types"]) delete facts[key]
  return {
    ...existing,
    name: fields.name || existing.name,
    context: shown.context,
    value: shown.value,
    updated: "Now",
    freshness: "Now",
    facts: { ...facts, ...shown.facts },
    projectIds: shown.projectIds,
    recordKind: shown.recordKind,
    submittedValues: masterDataTypedValues(kind, merged),
  }
}
