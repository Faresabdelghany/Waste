// The master data pane's own rules (#176): which kind a record is, read the
// way the adapters own it; the four forms; the records the pane writes; and
// the cadence a frequency's numbers spell.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { getBusinessModuleHref, masterDataSettingsHref, MASTER_DATA_SETTINGS_PANE_ID } from "../business-links"
import { getModuleDefinition, type BusinessRecord } from "../business-modules"
import { settingsModuleDomains } from "../business-domain"
import { getBusinessFormSchema } from "../business-form-schemas"
import {
  cadenceLabel,
  createMasterDataRecord,
  MASTER_DATA_KINDS,
  MASTER_DATA_MODULE,
  masterDataEditSchema,
  masterDataFieldErrors,
  masterDataFormValues,
  masterDataKindForField,
  masterDataKindOf,
  masterDataSchema,
  updateMasterDataRecord,
} from "../master-data"

const lookups = { projectName: (id: string) => (id === "project-copenhagen" ? "Copenhagen Central" : undefined), containerTypeName: (id: string) => (id === "container-type-1" ? "Two-wheel bin · 240 L" : undefined) }
const write = { now: 1700000000000, actorName: "Olivia Larsen", lookups }

describe("the master data module", () => {
  test("is one seam: the configure.master module, its Settings pane and its href", () => {
    assert.deepEqual(MASTER_DATA_MODULE, { workspaceId: "configure", moduleId: "master" })
    assert.ok(getModuleDefinition(MASTER_DATA_MODULE))
    const domain = settingsModuleDomains.find((module) => module.moduleId === "master")
    assert.equal(domain?.settingsPaneId, MASTER_DATA_SETTINGS_PANE_ID)
    assert.equal(masterDataSettingsHref(), `/settings?pane=${MASTER_DATA_SETTINGS_PANE_ID}`)
    assert.equal(masterDataSettingsHref("container-type"), `/settings?pane=${MASTER_DATA_SETTINGS_PANE_ID}&kind=container-type`)
    // The generic registry keeps no create form for the module: the pane's four are local, so fixture mode gains no button it never had.
    assert.equal(getBusinessFormSchema("configure", "master")?.mode, "disabled")
  })

  test("a record's kind is its id prefix first, then the typed kind it carries, and nothing for the fixtures' master-data sets", () => {
    const fixture = getModuleDefinition(MASTER_DATA_MODULE)?.records[0]
    assert.ok(fixture)
    assert.equal(masterDataKindOf(fixture), null)
    const byPrefix = (id: string): BusinessRecord => ({ ...fixture, id, name: id, submittedValues: undefined })
    assert.equal(masterDataKindOf(byPrefix("fraction-01")), "waste-fraction")
    assert.equal(masterDataKindOf(byPrefix("container-type-01")), "container-type")
    assert.equal(masterDataKindOf(byPrefix("frequency-01")), "service-frequency")
    assert.equal(masterDataKindOf(byPrefix("vehicle-type-01")), "vehicle-type")
    assert.equal(masterDataKindOf({ ...fixture, id: "master-renamed", submittedValues: { kind: "waste-fraction" } }), "waste-fraction", "a row the pane minted is known by the kind it typed")
    assert.equal(masterDataKindOf({ ...fixture, id: "master-renamed", submittedValues: { kind: "something-else" } }), null)
  })

  test("a picker's field says which list it wants, by the field's name, and nothing for a field that names no kind", () => {
    assert.equal(masterDataKindForField("materialFraction"), "waste-fraction")
    assert.equal(masterDataKindForField("plannedFraction"), "waste-fraction")
    assert.equal(masterDataKindForField("acceptedFractionId"), "waste-fraction")
    assert.equal(masterDataKindForField("vehicleType"), "vehicle-type")
    assert.equal(masterDataKindForField("containerTypeIds"), "container-type")
    assert.equal(masterDataKindForField("serviceFrequencyId"), "service-frequency")
    assert.equal(masterDataKindForField("reasonCode"), null)
    assert.equal(masterDataKindForField("fuelOrEnergyType"), null)
  })
})

describe("the four forms", () => {
  test("each names its kind's fields, the name as the record's name, and creates a row in force", () => {
    for (const kind of MASTER_DATA_KINDS) {
      const schema = masterDataSchema(kind)
      assert.equal(schema.key, "configure.master")
      assert.equal(schema.nameField, "name")
      assert.equal(schema.execution?.initialStatus, "Effective")
      const ids = schema.sections.flatMap((section) => section.fields.map((field) => field.id))
      assert.ok(ids.includes("name"), kind)
      assert.ok(!ids.includes("kind"), "the kind is the tab, not a field")
    }
    const fields = (kind: (typeof MASTER_DATA_KINDS)[number]) => masterDataSchema(kind).sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(fields("waste-fraction"), ["name", "key"])
    assert.deepEqual(fields("container-type"), ["name", "volumeLitres"])
    assert.deepEqual(fields("service-frequency"), ["name", "projectId", "description", "collectionsPerWeek", "weeksBetween", "daysBetween"])
    assert.deepEqual(fields("vehicle-type"), ["name", "key", "description", "containerTypeIds"])
    const projectField = masterDataSchema("service-frequency").sections.flatMap((section) => section.fields).find((field) => field.id === "projectId")
    assert.deepEqual(projectField?.relation, { workspaceId: "configure", moduleId: "organization" })
    const typesField = masterDataSchema("vehicle-type").sections.flatMap((section) => section.fields).find((field) => field.id === "containerTypeIds")
    assert.equal(typesField?.type, "multiselect")
    assert.deepEqual(typesField?.relation, MASTER_DATA_MODULE)
  })

  test("the edit form holds the key and the project read-only, since neither moves on the wire", () => {
    const edit = masterDataEditSchema("vehicle-type")
    assert.equal(edit.submitLabel, "Save changes")
    assert.equal(edit.title, "Edit vehicle type")
    const key = edit.sections.flatMap((section) => section.fields).find((field) => field.id === "key")
    assert.equal(key?.readOnly, true)
    const project = masterDataEditSchema("service-frequency").sections.flatMap((section) => section.fields).find((field) => field.id === "projectId")
    assert.equal(project?.readOnly, true)
    assert.equal(masterDataSchema("vehicle-type").sections.flatMap((section) => section.fields).find((field) => field.id === "key")?.readOnly, undefined)
  })
})

describe("the records the pane writes", () => {
  test("a created row is minted under its kind's prefix, in force, its facts from the form", () => {
    const record = createMasterDataRecord("service-frequency", { name: "Every 3 weeks", projectId: "project-copenhagen", collectionsPerWeek: "1", weeksBetween: "3" }, write)
    assert.equal(record.id, "frequency-1700000000000")
    assert.equal(record.name, "Every 3 weeks")
    assert.equal(record.status, "Effective")
    assert.equal(record.recordKind, "Service frequency")
    assert.equal(record.context, "Service frequency · Copenhagen Central")
    assert.equal(record.facts.Kind, "Service frequency")
    assert.equal(record.facts.Project, "Copenhagen Central")
    assert.equal(record.facts.Cadence, "Every 3 weeks")
    assert.equal(record.value, "Every 3 weeks")
    assert.deepEqual(record.projectIds, ["project-copenhagen"])
    assert.deepEqual(record.submittedValues, { kind: "service-frequency", name: "Every 3 weeks", projectId: "project-copenhagen", collectionsPerWeek: "1", weeksBetween: "3" })
    assert.equal(masterDataKindOf(record), "service-frequency")
    const type = createMasterDataRecord("vehicle-type", { name: "Side loader", key: "side-loader", containerTypeIds: "container-type-1" }, write)
    assert.equal(type.id, "vehicle-type-1700000000000")
    assert.equal(type.facts["Container types"], "Two-wheel bin · 240 L")
    assert.equal(type.value, "1 container type")
    assert.deepEqual(type.projectIds, [], "the company's: every scope shows it")
  })

  test("an edited row keeps its identity and takes the form's values, a cleared field dropping its fact", () => {
    const record = createMasterDataRecord("container-type", { name: "Skip", volumeLitres: "8000" }, write)
    assert.equal(record.facts.Volume, "8,000 L")
    const edited = updateMasterDataRecord(record, { name: "Open skip", volumeLitres: "" }, lookups)
    assert.equal(edited.id, record.id)
    assert.equal(edited.name, "Open skip")
    assert.equal(edited.facts.Volume, undefined)
    assert.equal(edited.context, "Container type · volume not recorded")
    assert.deepEqual(edited.submittedValues, { kind: "container-type", name: "Open skip" })
    assert.deepEqual(masterDataFormValues(edited), { name: "Open skip" })
    assert.deepEqual(masterDataFormValues(record), { name: "Skip", volumeLitres: "8000" })
  })
})

describe("a cadence", () => {
  test("reads the way the contract explains the three numbers", () => {
    assert.equal(cadenceLabel({ collectionsPerWeek: null, weeksBetween: null, daysBetween: null }), "On demand")
    assert.equal(cadenceLabel({ collectionsPerWeek: 1, weeksBetween: 1, daysBetween: null }), "Every week")
    assert.equal(cadenceLabel({ collectionsPerWeek: 1, weeksBetween: 2, daysBetween: null }), "Every 2 weeks")
    assert.equal(cadenceLabel({ collectionsPerWeek: 1, weeksBetween: null, daysBetween: null }), "Once a month")
    assert.equal(cadenceLabel({ collectionsPerWeek: 2, weeksBetween: null, daysBetween: 3 }), "2 collections a week, every 3 days")
    assert.equal(cadenceLabel({ collectionsPerWeek: 3, weeksBetween: null, daysBetween: null }), "3 collections a week")
    assert.equal(cadenceLabel({ collectionsPerWeek: 2, weeksBetween: 1, daysBetween: null }), "2 collections a week", "a rate above one keeps its rate beside the interval")
    assert.equal(cadenceLabel({ collectionsPerWeek: 3, weeksBetween: 2, daysBetween: null }), "3 collections every 2 weeks")
  })
})

describe("the rules a form is held to, inline", () => {
  test("say what the adapter would refuse, by field, in the same words", () => {
    assert.deepEqual(masterDataFieldErrors("waste-fraction", { name: "", key: "Hard Plastic" }), { name: "A waste fraction needs a name", key: "A key is a lowercase slug of letters, digits and single hyphens, such as hard-plastic" })
    assert.deepEqual(masterDataFieldErrors("waste-fraction", { name: "Hard plastic", key: "hard-plastic" }), {})
    assert.deepEqual(masterDataFieldErrors("container-type", { name: "Skip", volumeLitres: "2.5" }), { volumeLitres: "A volume is a whole number of litres" })
    assert.deepEqual(masterDataFieldErrors("container-type", { name: "Skip", volumeLitres: "240.0" }), {}, "a whole number a number input spells with a decimal point is whole")
    assert.deepEqual(masterDataFieldErrors("service-frequency", { name: "Weekly", projectId: "project-copenhagen", weeksBetween: "2" }), { collectionsPerWeek: "Give collectionsPerWeek with at most one of weeksBetween and daysBetween, or none of the three (on demand)" })
    assert.deepEqual(masterDataFieldErrors("service-frequency", { name: "Weekly", projectId: "", weeksBetween: "1.5" }), { projectId: "Pick a project", weeksBetween: "Weeks between is a whole number, 1 or more" }, "a count that is no count is named before the cadence is judged")
    assert.deepEqual(masterDataFieldErrors("vehicle-type", { name: "Side loader", key: "side-loader" }), {})
  })

  test("a whole volume spelled with a decimal point is stored as the form spelled it and shown as the number", () => {
    const record = createMasterDataRecord("container-type", { name: "Skip", volumeLitres: "240.0" }, write)
    assert.equal(record.facts.Volume, "240 L")
    assert.equal(record.submittedValues?.volumeLitres, "240.0")
  })
})

describe("a master data row's link", () => {
  test("lands on the pane for a row of a kind, and keeps a fixture master-data set under Operations setup", () => {
    assert.equal(getBusinessModuleHref("configure", "master", "fraction-01"), `/settings?pane=${MASTER_DATA_SETTINGS_PANE_ID}&record=fraction-01`)
    assert.equal(getBusinessModuleHref("configure", "master", "master-fractions"), "/settings?pane=operations-setup&record=master-fractions")
    assert.equal(getBusinessModuleHref("configure", "master"), `/settings?pane=${MASTER_DATA_SETTINGS_PANE_ID}`)
  })
})
