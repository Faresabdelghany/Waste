"use client"
// The pickers of the Price Engine's Pilot dialogs (Issue #185): the command
// surfaces' own (`useRelationPickers`: the project, the master data, the
// customers) with the rows the customer-money chain names besides — the price
// lists of `commercial.price-rows`, the products, the planning areas and the
// agreements — each read from the module the store loaded, every row offered
// and its status beside its name where it is not Active (#79: a status gates a
// new reference and the API's 409 says so). An optional select offers None,
// since a select is never emptied once picked; the forms read it as blank
// (`blankNone`, lib/data/commercial-forms.ts). A resolver over the same
// modules turns a dialog's web ids into the server's for a read that is not
// the store's — Explain price's question.
import { isSoftDeleted } from "@waste/domain/record-visibility"

import { resolverOver, type ModuleState } from "@/lib/api/records/server-records"
import type { Resolver } from "@/lib/api/records/adapter"
import { AGREEMENTS_MODULE } from "@/lib/data/agreements"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { INVOICES_MODULE, PRICE_ROWS_MODULE, PRODUCTS_MODULE } from "@/lib/data/commercial"
import { commercialRowsFor } from "@/lib/data/commercial-pickers"
import { ORGANISATION_MODULE } from "@/lib/data/containers"
import { MASTER_DATA_MODULE } from "@/lib/data/master-data"
import { keptOptions, keptValue, rowOptions } from "@/lib/data/place-pickers"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import { SERVICE_AREAS_MODULE, SERVICE_PROVIDERS_MODULE } from "@/lib/data/provider-money"
import { CONTACTS_MODULE, NO_ONE } from "@/lib/data/properties"

import { useModuleRecords, useServerModuleState } from "../business-record-store"
import { useRelationPickers, type RelationPickers } from "./use-command-support"

const NO_RECORDS: readonly BusinessRecord[] = []
const fixturesOf = (location: ModuleLocation) => getModuleDefinition(location)?.records ?? NO_RECORDS
const keyOf = (location: ModuleLocation) => `${location.workspaceId}.${location.moduleId}`
const live = (records: readonly BusinessRecord[]) => records.filter((record) => !isSoftDeleted(record))

/** The pickers the Price Engine's dialogs read: the command surfaces' own, and the chain's rows by field. */
export function useCommercialPickers(): RelationPickers {
  const base = useRelationPickers()
  const products = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, fixturesOf(PRODUCTS_MODULE))
  const priceRows = useModuleRecords(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId, fixturesOf(PRICE_ROWS_MODULE))
  const areas = useModuleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId, fixturesOf(PLANNING_AREAS_MODULE))
  const agreements = useModuleRecords(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId, fixturesOf(AGREEMENTS_MODULE))
  // The provider-money chain's (#186).
  const providers = useModuleRecords(SERVICE_PROVIDERS_MODULE.workspaceId, SERVICE_PROVIDERS_MODULE.moduleId, fixturesOf(SERVICE_PROVIDERS_MODULE))
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, fixturesOf(MASTER_DATA_MODULE))
  const serviceAreas = useModuleRecords(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId, fixturesOf(SERVICE_AREAS_MODULE))
  // The invoices a payment pays (#291 C6).
  const invoices = useModuleRecords(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId, fixturesOf(INVOICES_MODULE))
  const byKey = new Map([
    [keyOf(PRODUCTS_MODULE), products],
    [keyOf(PRICE_ROWS_MODULE), priceRows],
    [keyOf(PLANNING_AREAS_MODULE), areas],
    [keyOf(AGREEMENTS_MODULE), agreements],
    [keyOf(SERVICE_PROVIDERS_MODULE), providers],
    [keyOf(SERVICE_AREAS_MODULE), serviceAreas],
    [keyOf(INVOICES_MODULE), invoices],
  ])
  const held = {
    products: live(products.records),
    priceRows: live(priceRows.records),
    areas: live(areas.records),
    agreements: live(agreements.records),
    providers: live(providers.records),
    master: live(master.records),
    serviceAreas: live(serviceAreas.records),
    invoices: live(invoices.records),
  }
  const options = (field: BusinessFormField, values: BusinessFormValues, projectId?: string, opened?: BusinessFormValues): readonly BusinessFormOption[] => {
    const rows = commercialRowsFor(field.id, values, held, projectId)
    const offered = rows === undefined ? base.options(field, values, projectId, opened) : keptOptions(field, rowOptions(rows), keptValue(field.id, values, opened))
    // An optional pick can be taken back only by picking None.
    return field.type === "select" && !field.required && !offered.some((option) => option.value === NO_ONE) ? [{ value: NO_ONE, label: "None" }, ...offered] : offered
  }
  // A module the role does not view is nothing to wait for, as the command surfaces' own pickers have it.
  const readyFor = (schema: BusinessFormSchema) =>
    base.readyFor(schema) &&
    schema.sections.every((section) =>
      section.fields.every((field) => {
        const state = field.relation === undefined ? undefined : byKey.get(keyOf(field.relation))
        return state === undefined || state.ready || state.notGranted
      }),
    )
  return { readyFor, options, timezoneOf: base.timezoneOf }
}

/** The modules a Price Engine dialog's web ids may name, for `useCommercialResolver`. */
const RESOLVED_MODULES: readonly ModuleLocation[] = [ORGANISATION_MODULE, MASTER_DATA_MODULE, CONTACTS_MODULE, PLANNING_AREAS_MODULE, AGREEMENTS_MODULE, PRODUCTS_MODULE, PRICE_ROWS_MODULE, INVOICES_MODULE]

/** A resolver over the modules the chain's dialogs name rows of, as the store holds them now: for a read the surface asks itself (Explain price, Run billing's preview). */
export function useCommercialResolver(): Resolver {
  const organisation = useServerModuleState(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId)
  const master = useServerModuleState(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId)
  const contacts = useServerModuleState(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId)
  const areas = useServerModuleState(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId)
  const agreements = useServerModuleState(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId)
  const products = useServerModuleState(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId)
  const priceRows = useServerModuleState(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId)
  const invoices = useServerModuleState(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId)
  const states = [organisation, master, contacts, areas, agreements, products, priceRows, invoices]
  const entries = RESOLVED_MODULES.flatMap((location, index): [string, ModuleState][] => {
    const state = states[index]
    return state === null ? [] : [[keyOf(location), state]]
  })
  return resolverOver(new Map(entries))
}
