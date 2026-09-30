"use client"
// What the command surfaces share (Issue #181): the pickers their dialogs
// name other modules' rows by — since #184 the customers, the properties and
// the subscriptions too, their words in lib/data/place-pickers.ts — whether a surface's own module and its forms'
// modules have answered, a read of one row's appended history (a container's
// ledger, an allocation's events) from the API, and opening a row made.
//
// A picker reads the module the store loaded: a switched module's rows once
// the API has answered and nothing before (`useModuleRecords` on the Pilot),
// a module not switched yet its fixtures, which the adapter then refuses by
// name since the API holds no such row. It shows every row — a status gates
// a new reference and never an existing one (#79), so a closed warehouse or a
// retired vehicle is listed with its status beside its name, and the API's
// 409 says why it was refused.
import { useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import type { ApiClient } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { depotAdapter, unloadingStationAdapter } from "@/lib/api/records/places"
import { problemOfError, type CommandOutcome, type WriteOutcome } from "@/lib/api/records/server-records"
import { AGREEMENTS_MODULE } from "@/lib/data/agreements"
import { DEPOTS_MODULE, DRIVERS_MODULE, isTrailerRecord, VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation, type WorkspaceId } from "@/lib/data/business-modules"
import { ORGANISATION_MODULE, WAREHOUSES_MODULE } from "@/lib/data/containers"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"
import type { MasterDataKind } from "@/lib/data/master-data-kinds"
import { keptOptions, keptValue, optionalRowOptions, rowOptions, subscriptionOptions } from "@/lib/data/place-pickers"
import { CONTACTS_MODULE, PROPERTIES_MODULE } from "@/lib/data/properties"
import { isSoftDeleted } from "@waste/domain/record-visibility"

import { useApiClient } from "../api-session-store"
import { useBusinessRecordStore, useMeProjects, useModuleRecords, useServerModuleState, whenSaved } from "../business-record-store"
import type { CommandInput } from "@/lib/api/records/adapter"

/** What a command the API took answers: the row as the API now holds it. */
export type CommandDone = Extract<CommandOutcome, { kind: "done" }>

/**
 * A row's commands and writes sent one at a time from its surface: `busy`
 * while one is out, `version` bumped after each the API took, so the row's
 * own reads (`useRowHistory`: a ledger, a history, a route's stops) are read
 * again. `run` sends a command and tells `done` what the API answered; `save`
 * waits on a write the surface made and tells `done` it landed. A refusal is
 * the store's toast, in the API's words, and the surface stands as it was.
 */
export function useCommandRunner(module: ModuleLocation, recordId: string): {
  busy: boolean
  version: number
  run: (name: string, input: CommandInput | undefined, done: (outcome: CommandDone) => void) => void
  save: (outcome: Promise<WriteOutcome> | undefined, done: () => void) => void
} {
  const { sendCommand } = useBusinessRecordStore()
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const bump = () => setVersion((current) => current + 1)
  const run = (name: string, input: CommandInput | undefined, done: (outcome: CommandDone) => void) => {
    if (busy) return
    setBusy(true)
    void sendCommand(module.workspaceId, module.moduleId, recordId, name, input).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      bump()
      done(outcome)
    })
  }
  const save = (outcome: Promise<WriteOutcome> | undefined, done: () => void) => {
    setBusy(true)
    whenSaved(
      outcome,
      () => {
        done()
        bump()
      },
      () => setBusy(false),
    )
  }
  return { busy, version, run, save }
}

const NO_RECORDS: readonly BusinessRecord[] = []
const fixturesOf = (location: ModuleLocation) => getModuleDefinition(location)?.records ?? NO_RECORDS
const keyOf = (location: ModuleLocation) => `${location.workspaceId}.${location.moduleId}`

/** Which master-data kind a field picks, by its id. */
const MASTER_KIND_BY_FIELD: Readonly<Record<string, MasterDataKind>> = {
  containerType: "container-type",
  wasteFraction: "waste-fraction",
  wasteFractionId: "waste-fraction",
  plannedFraction: "waste-fraction",
  serviceFrequencyId: "service-frequency",
}

/** A row as a picker offers it: its name, and its status beside it where the status says something. */
const optionOf = (record: BusinessRecord, withStatus: boolean): BusinessFormOption => ({ value: record.id, label: withStatus ? `${record.name} · ${record.status}` : record.name })

export type RelationPickers = {
  /** Whether every module a form's relation fields read has answered: one module that failed holds back only the forms that pick from it. */
  readyFor: (schema: BusinessFormSchema) => boolean
  /**
   * The options a relation field offers, by its id; a frequency or a member
   * property only of the project the form names (or `projectId`). `opened` is
   * what the dialog opened with, the one value kept offered though no row
   * holds it (`keptValue`): `{}` for a create.
   */
  options: (field: BusinessFormField, values: BusinessFormValues, projectId?: string, opened?: BusinessFormValues) => readonly BusinessFormOption[]
  /** The timezone of a project, by its web id, as the organisation module holds it. */
  timezoneOf: (projectId: string | undefined) => string | undefined
}

/** The pickers the containers', the allocations', the places' and the routes' dialogs read. */
export function useRelationPickers(): RelationPickers {
  const organisation = useModuleRecords(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId, fixturesOf(ORGANISATION_MODULE))
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, fixturesOf(MASTER_DATA_MODULE))
  const warehouses = useModuleRecords(WAREHOUSES_MODULE.workspaceId, WAREHOUSES_MODULE.moduleId, fixturesOf(WAREHOUSES_MODULE))
  const vehicles = useModuleRecords(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId, fixturesOf(VEHICLES_MODULE))
  const drivers = useModuleRecords(DRIVERS_MODULE.workspaceId, DRIVERS_MODULE.moduleId, fixturesOf(DRIVERS_MODULE))
  const depots = useModuleRecords(DEPOTS_MODULE.workspaceId, DEPOTS_MODULE.moduleId, fixturesOf(DEPOTS_MODULE))
  const contacts = useModuleRecords(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId, fixturesOf(CONTACTS_MODULE))
  const properties = useModuleRecords(PROPERTIES_MODULE.workspaceId, PROPERTIES_MODULE.moduleId, fixturesOf(PROPERTIES_MODULE))
  const agreements = useModuleRecords(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId, fixturesOf(AGREEMENTS_MODULE))
  // A role that does not view the organisation picks from `/me`'s projects (Issue #217).
  const meProjects = useMeProjects()
  const byKey = new Map([
    [keyOf(ORGANISATION_MODULE), organisation],
    [keyOf(MASTER_DATA_MODULE), master],
    [keyOf(WAREHOUSES_MODULE), warehouses],
    [keyOf(VEHICLES_MODULE), vehicles],
    [keyOf(DRIVERS_MODULE), drivers],
    [keyOf(DEPOTS_MODULE), depots],
    [keyOf(CONTACTS_MODULE), contacts],
    [keyOf(PROPERTIES_MODULE), properties],
    [keyOf(AGREEMENTS_MODULE), agreements],
  ])
  const live = (records: readonly BusinessRecord[]) => records.filter((record) => !isSoftDeleted(record))
  const rowsFor = (field: BusinessFormField, values: BusinessFormValues, projectId?: string): readonly BusinessFormOption[] => {
    const kind = MASTER_KIND_BY_FIELD[field.id]
    if (kind !== undefined) {
      const project = projectId ?? (typeof values.projectId === "string" ? values.projectId : undefined)
      return live(master.records)
        .filter((record) => masterDataKindOf(record) === kind)
        .filter((record) => kind !== "service-frequency" || project === undefined || record.projectIds?.includes(project))
        .map((record) => optionOf(record, false))
    }
    const project = projectId ?? (typeof values.projectId === "string" && values.projectId !== "" ? values.projectId : undefined)
    // A party, a responsible customer: any Customer of the company, a person or an organisation alike; None first where one pick is optional.
    if (field.relation !== undefined && keyOf(field.relation) === keyOf(CONTACTS_MODULE)) {
      return field.type === "select" && !field.required ? optionalRowOptions(live(contacts.records)) : rowOptions(live(contacts.records))
    }
    // A member property: the form's project's, since a set holds its own project's properties alone.
    if (field.relation !== undefined && keyOf(field.relation) === keyOf(PROPERTIES_MODULE)) {
      return rowOptions(live(properties.records).filter((record) => project === undefined || !record.projectIds?.length || record.projectIds.includes(project)))
    }
    switch (field.id) {
      case "subscriptionId":
        return subscriptionOptions(live(agreements.records), project)
      case "projectId":
        return (organisation.notGranted ? meProjects : live(organisation.records).filter((record) => record.id.startsWith("project-"))).map((record) => optionOf(record, false))
      case "warehouseId":
        return live(warehouses.records).map((record) => optionOf(record, true))
      // The fleet module holds the powered vehicles and the trailers: each field offers its own kind (#179).
      case "vehicleId":
        return live(vehicles.records)
          .filter((record) => !isTrailerRecord(record))
          .map((record) => optionOf(record, true))
      case "trailerId":
        return live(vehicles.records).filter(isTrailerRecord).map((record) => optionOf(record, true))
      case "driverId":
        return live(drivers.records).map((record) => optionOf(record, true))
      // The places module holds the depots and the unloading stations: each field offers its own kind (#179).
      case "depotId":
        return live(depots.records).filter(depotAdapter.owns).map((record) => optionOf(record, true))
      case "unloadingStationId":
        return live(depots.records).filter(unloadingStationAdapter.owns).map((record) => optionOf(record, true))
      default:
        return field.options ?? []
    }
  }
  // The value a form opens with stays offered, as its id chip where the
  // module has no such row loaded: an existing reference is never refused.
  const options = (field: BusinessFormField, values: BusinessFormValues, projectId?: string, opened?: BusinessFormValues): readonly BusinessFormOption[] =>
    keptOptions(field, rowsFor(field, values, projectId), keptValue(field.id, values, opened))
  // A module the role does not view is nothing to wait for: its picker offers what the person has, and the rest of the form stands (Issue #217).
  const answered = (state: { ready: boolean; notGranted: boolean } | undefined) => state === undefined || state.ready || state.notGranted
  const readyFor = (schema: BusinessFormSchema) =>
    schema.sections.every((section) => section.fields.every((field) => field.relation === undefined || answered(byKey.get(keyOf(field.relation)))))
  const timezoneOf = (projectId: string | undefined) => {
    const project = projectId === undefined ? undefined : organisation.records.find((record) => record.id === projectId)
    const timezone = project?.submittedValues?.timezone
    return typeof timezone === "string" && timezone !== "" ? timezone : undefined
  }
  return { readyFor, options, timezoneOf }
}

/** Whether a surface's own module reads the API's rows now: on the Pilot, nothing is written or commanded through it before, nor after its load failed. */
export function useModuleReady(location: ModuleLocation): boolean {
  return useModuleRecords(location.workspaceId, location.moduleId, fixturesOf(location)).ready
}

/** The name a switched module's row goes by, from its server id; its id chip where the module has not loaded it. */
export function useServerNames(location: ModuleLocation, prefix: string): (serverId: string) => string {
  const state = useServerModuleState(location.workspaceId, location.moduleId)
  return (serverId) => {
    for (const [webId, id] of state?.serverIds ?? []) {
      if (id === serverId) return state?.records.find((record) => record.id === webId)?.name ?? webId
    }
    return `${prefix}-${serverId}`
  }
}

/**
 * Opens a row of the module in the workspace's details, through the address
 * bar's `?record=` the workspace reads: what a create surface does once the
 * API has answered, as the generic create path opens what it made. The
 * minted id is the row's for the session (server-records.ts, `withCreated`).
 */
export function useOpenRecord(moduleId: string): (recordId: string) => void {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  return (recordId) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("module", moduleId)
    params.set("record", recordId)
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }
}

type Read<T> = { key: string; rows: T[] | null; problem: string | null }

/**
 * One row's appended history read from the API — `read(client, serverId)` —
 * again whenever `version` moves: the surface bumps it after each command or
 * write it sent, since a movement need not change anything the row shows
 * (a transfer between two warehouses keeps the status) nor its stamps.
 * Nothing until the row is on the API.
 */
export function useRowHistory<T>(workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord, version: number, read: (client: ApiClient, serverId: string) => Promise<T[]>): { rows: T[] | null; problem: string | null } {
  const client = useApiClient()
  const serverId = useServerModuleState(workspaceId, moduleId)?.serverIds.get(record.id)
  const key = `${serverId ?? ""}|${version}`
  const [state, setState] = useState<Read<T>>({ key: "", rows: null, problem: null })
  useEffect(() => {
    if (client === null || serverId === undefined) return
    let current = true
    read(client, serverId).then(
      (rows) => current && setState({ key, rows, problem: null }),
      (error: unknown) => current && setState({ key, rows: null, problem: problemSentence(problemOfError(error)) }),
    )
    return () => {
      current = false
    }
  }, [client, key, read, serverId])
  return state.key === key ? { rows: state.rows, problem: state.problem } : { rows: null, problem: null }
}
