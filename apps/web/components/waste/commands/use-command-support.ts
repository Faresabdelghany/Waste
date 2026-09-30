"use client"
// What the command surfaces share (Issue #181): the pickers their dialogs
// name other modules' rows by, and a read of one row's appended history (a
// container's ledger, an allocation's events) from the API.
//
// A picker reads the module the store loaded and offers nothing until that
// module is ready (the rules on #81): on the Pilot `useModuleRecords` answers
// no rows before the API has. It shows every row — a status gates a new
// reference and never an existing one (#79), so a closed warehouse or a
// retired vehicle is listed with its status beside its name, and the API's
// 409 says why it was refused.
import { useEffect, useState } from "react"

import type { ApiClient } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import type { BusinessFormField, BusinessFormOption, BusinessFormValues } from "@/lib/data/business-form-types"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation, type WorkspaceId } from "@/lib/data/business-modules"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"
import type { MasterDataKind } from "@/lib/data/master-data-kinds"
import { isSoftDeleted } from "@waste/domain/record-visibility"

import { useApiClient } from "../api-session-store"
import { useModuleRecords, useServerModuleState } from "../business-record-store"

const ORGANISATION: ModuleLocation = { workspaceId: "configure", moduleId: "organization" }
export const WAREHOUSES: ModuleLocation = { workspaceId: "resources", moduleId: "warehouses" }
const VEHICLES: ModuleLocation = { workspaceId: "fleet", moduleId: "vehicles" }
const DRIVERS: ModuleLocation = { workspaceId: "fleet", moduleId: "drivers" }
const DEPOTS: ModuleLocation = { workspaceId: "resources", moduleId: "depots" }

const fixturesOf = (location: ModuleLocation) => getModuleDefinition(location)?.records ?? []

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
  /** Whether every module the pickers read has answered. */
  ready: boolean
  /** The options a relation field offers, by its id; a frequency only of the project the form names (or `projectId`). */
  options: (field: BusinessFormField, values: BusinessFormValues, projectId?: string) => readonly BusinessFormOption[]
}

/** The pickers the containers' and the allocations' dialogs read. */
export function useRelationPickers(): RelationPickers {
  const organisation = useModuleRecords(ORGANISATION.workspaceId, ORGANISATION.moduleId, fixturesOf(ORGANISATION))
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, fixturesOf(MASTER_DATA_MODULE))
  const warehouses = useModuleRecords(WAREHOUSES.workspaceId, WAREHOUSES.moduleId, fixturesOf(WAREHOUSES))
  const vehicles = useModuleRecords(VEHICLES.workspaceId, VEHICLES.moduleId, fixturesOf(VEHICLES))
  const drivers = useModuleRecords(DRIVERS.workspaceId, DRIVERS.moduleId, fixturesOf(DRIVERS))
  const depots = useModuleRecords(DEPOTS.workspaceId, DEPOTS.moduleId, fixturesOf(DEPOTS))
  const live = (records: readonly BusinessRecord[]) => records.filter((record) => !isSoftDeleted(record))
  const options = (field: BusinessFormField, values: BusinessFormValues, projectId?: string): readonly BusinessFormOption[] => {
    const kind = MASTER_KIND_BY_FIELD[field.id]
    if (kind !== undefined) {
      const project = projectId ?? (typeof values.projectId === "string" ? values.projectId : undefined)
      return live(master.records)
        .filter((record) => masterDataKindOf(record) === kind)
        .filter((record) => kind !== "service-frequency" || project === undefined || record.projectIds?.includes(project))
        .map((record) => optionOf(record, false))
    }
    switch (field.id) {
      case "projectId":
        return live(organisation.records).filter((record) => record.id.startsWith("project-")).map((record) => optionOf(record, false))
      case "warehouseId":
        return live(warehouses.records).map((record) => optionOf(record, true))
      case "vehicleId":
      case "trailerId":
        return live(vehicles.records).map((record) => optionOf(record, true))
      case "driverId":
        return live(drivers.records).map((record) => optionOf(record, true))
      case "depotId":
        return live(depots.records).map((record) => optionOf(record, true))
      default:
        return field.options ?? []
    }
  }
  return { ready: [organisation, master, warehouses, vehicles, drivers, depots].every((module) => module.ready), options }
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

type Read<T> = { key: string; rows: T[] | null; problem: string | null }

/**
 * One row's appended history read from the API — `read(client, serverId)` —
 * again whenever the row changes (`record.updated` moves with every answer
 * the store puts in its place). Nothing until the row is on the API.
 */
export function useRowHistory<T>(workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord, read: (client: ApiClient, serverId: string) => Promise<T[]>): { rows: T[] | null; problem: string | null } {
  const client = useApiClient()
  const serverId = useServerModuleState(workspaceId, moduleId)?.serverIds.get(record.id)
  const key = `${serverId ?? ""}|${record.updated}|${record.status}`
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
