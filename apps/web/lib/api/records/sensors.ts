// The fill-level Sensors on the prototype's records (O26 of #290, row 9.10):
// `resources.sensors`, a project's sensors, each with the container it
// measures today and its newest reading. The wire shapes are the contracts'
// (`@waste/contracts/sensors`), imported as types so no zod reaches the
// bundle; the routes are apps/api/src/routes/sensors.ts.
//
// A sensor is registered and corrected through the generic form (its project,
// identifier, network and note) and retired by its status. Its pairings are
// its commands, sent through the store and answered by the sensor read again,
// since the API answers a pairing: Pair names a container of the sensor's
// project, the first day it measures it, the full threshold and whether a
// filling books an emptying; Change pairing moves the pairing in force's
// threshold, its booking or its end. Every period is spelled to a person as
// its last day in force where the wire's `validTo` is the first day out
// (`lastDayIn`/`firstDayOut`). The readings are read beside the row
// (`sensorReadings`), never through the store.
import type { FillReading, Sensor, SensorPairing } from "@waste/contracts/sensors"
import { SENSOR_NETWORKS, SENSOR_STATUSES } from "@waste/domain/resources/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"

import { create, get, listAll, listPage, patch, type ApiClient } from "../client"
import { hasPrefix, inheritedPresentation, isLocalRefusal, patchOf, said, stampFacts, statusLabel, typed, webIdOf, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn } from "./clock"
import { containerAdapter } from "./containers"
import { createStatusOf, patchStatusOf, projectMoved, projectServerIdOf, referenced, refusal, requiredText, tokenOf, withStatus } from "./places"
import { firstDayOut, lastDayIn } from "./planning"
import { nameVia, referencedServerId, webIdVia } from "./references"

/** The workspace module the sensors are the rows of. */
export const SENSORS_MODULE: ModuleLocation = { workspaceId: "resources", moduleId: "sensors" }

export const SENSOR_PREFIX = "sensor"
/** The containers' web prefix, which a pairing names a container by. */
const CONTAINER_PREFIX = "asset"

/** The sensor's commands, by the names its surface sends. */
export const PAIR_SENSOR = "pair"
export const CHANGE_PAIRING = "change-pairing"

/** The record's keys the pairing in force rides under, for the surface. */
export const PAIRING_ID_KEY = "pairingId"
export const PAIRING_CONTAINER_KEY = "pairingContainerId"

/** How each network is named. */
export const NETWORK_LABELS: Readonly<Record<(typeof SENSOR_NETWORKS)[number], string>> = { lorawan: "LoRaWAN", sigfox: "Sigfox", "nb-iot": "NB-IoT" }

const projectSetOnce = "A sensor stays in its project: register another sensor in the other project"

/** "62% · battery 91% · −97 dBm": a reading as its row reads it. */
export function readingLine(reading: Pick<FillReading, "fillPercent" | "batteryPercent" | "rssiDbm">): string {
  return [`${reading.fillPercent}%`, reading.batteryPercent === null ? undefined : `battery ${reading.batteryPercent}%`, reading.rssiDbm === null ? undefined : `${reading.rssiDbm} dBm`].filter(Boolean).join(" · ")
}

/** "BIN-82014 from 2026-10-01 to 2026-10-31 · full at 85% · books an emptying": a pairing as its row reads it, its end the last day in force. */
export function pairingLine(pairing: Pick<SensorPairing, "validFrom" | "validTo" | "fullThresholdPercent" | "booksEmptying">, container: string): string {
  const period = pairing.validTo === null ? `from ${pairing.validFrom}` : `from ${pairing.validFrom} to ${lastDayIn(pairing.validTo)}`
  return [`${container} ${period}`, `full at ${pairing.fullThresholdPercent}%`, pairing.booksEmptying ? "books an emptying" : undefined].filter(Boolean).join(" · ")
}

export function toSensorRecord(sensor: Sensor, context: MappingContext): BusinessRecord {
  const project = referenced(context, "project", sensor.projectId)
  const projectRecord = context.resolve.byServerId(sensor.projectId)
  const timezone = projectRecord === undefined ? undefined : typed(projectRecord, "timezone")
  const pairing = sensor.pairing
  const container = pairing === null ? undefined : nameVia(context, CONTAINER_PREFIX, pairing.containerId)
  const reading = sensor.lastReading
  const facts: Record<string, string> = {
    Network: NETWORK_LABELS[sensor.network],
    Container: pairing === null || container === undefined ? "Not paired today" : pairingLine(pairing, container),
    "Fill level": reading === null ? "No reading yet" : `${reading.fillPercent}%`,
    "Last measurement": reading === null ? "Never" : shownOn(reading.measuredAt, timezone),
    Project: project.name ?? project.webId,
  }
  if (reading?.batteryPercent != null) facts.Battery = `${reading.batteryPercent}%`
  if (reading?.rssiDbm != null) facts.RSSI = `${reading.rssiDbm} dBm`
  return {
    id: webIdOf(SENSOR_PREFIX, sensor.id),
    name: sensor.identifier,
    context: `${NETWORK_LABELS[sensor.network]} · ${container ?? "not paired"}`,
    status: statusLabel(sensor.status),
    ...inheritedPresentation(undefined),
    ...stampFacts(sensor, context.now),
    value: reading === null ? "No reading" : `${reading.fillPercent}%`,
    description: sensor.notes ?? "",
    related: container === undefined ? [] : [`Container ${container}`],
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [project.webId],
    recordKind: "Sensor",
    submittedValues: {
      projectId: project.webId,
      identifier: sensor.identifier,
      network: sensor.network,
      status: sensor.status,
      notes: sensor.notes ?? "",
      [PAIRING_ID_KEY]: pairing?.id ?? "",
      [PAIRING_CONTAINER_KEY]: pairing === null ? "" : webIdVia(context, CONTAINER_PREFIX, pairing.containerId),
      ...(pairing === null
        ? {}
        : { fullThresholdPercent: String(pairing.fullThresholdPercent), booksEmptying: pairing.booksEmptying, lastDayIn: pairing.validTo === null ? "" : lastDayIn(pairing.validTo) }),
    },
  }
}

/** A whole percent from 1 to 100 typed at `key`, or a refusal; undefined where nothing was typed. */
function thresholdOf(text: string | undefined): number | undefined | LocalRefusal {
  if (text === undefined) return undefined
  const value = Number(text)
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : refusal("fullThresholdPercent", "Give the full threshold as a whole percent from 1 to 100")
}

/** A yes or no the surface sent at `key`. */
const flagOf = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : undefined)

/** A day typed as `YYYY-MM-DD`, or a refusal at `key`. */
function dayOf(text: string, key: string): string | LocalRefusal {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : refusal(key, "Give the day as a date")
}

/** Reads the sensor back once a pairing command has landed: the API answers the pairing, the row is the sensor. */
const sensorAfter = (client: ApiClient, serverId: string) => get<Sensor>(client, `/sensors/${serverId}`)

export const SENSOR_COMMANDS = {
  [PAIR_SENSOR]: {
    toBody: (input, _record, context) => {
      const webId = said(input, "containerId")
      if (webId === undefined) return refusal("containerId", "Pick the container the sensor measures")
      const containerId = referencedServerId(webId, CONTAINER_PREFIX, context, { owns: containerAdapter.owns })
      if (containerId === undefined) return refusal("containerId", "Pick a container the API holds")
      const from = said(input, "validFrom")
      if (from === undefined) return refusal("validFrom", "Give the first day the sensor measures it")
      const validFrom = dayOf(from, "validFrom")
      if (isLocalRefusal(validFrom)) return validFrom
      const threshold = thresholdOf(said(input, "fullThresholdPercent"))
      if (isLocalRefusal(threshold)) return threshold
      const booksEmptying = flagOf(input.booksEmptying)
      return { containerId, validFrom, ...(threshold === undefined ? {} : { fullThresholdPercent: threshold }), ...(booksEmptying === undefined ? {} : { booksEmptying }) }
    },
    run: async (client, serverId, body) => {
      await create<SensorPairing>(client, `/sensors/${serverId}/pairings`, body)
      return await sensorAfter(client, serverId)
    },
    refused: (record) => `${record.name} was not paired`,
  },
  [CHANGE_PAIRING]: {
    toBody: (input, record) => {
      const pairingId = typed(record, PAIRING_ID_KEY)
      if (pairingId === undefined) return refusal("", `${record.name} measures no container today`)
      const threshold = thresholdOf(said(input, "fullThresholdPercent"))
      if (isLocalRefusal(threshold)) return threshold
      const booksEmptying = flagOf(input.booksEmptying)
      // The last day in force the person typed, as the wire's first day out; blank leaves the pairing open.
      const last = typeof input.lastDayIn === "string" ? input.lastDayIn.trim() : undefined
      let validTo: string | null | undefined
      if (last !== undefined) {
        if (last === "") validTo = null
        else {
          const day = dayOf(last, "lastDayIn")
          if (isLocalRefusal(day)) return day
          validTo = firstDayOut(day)
        }
      }
      const change = { ...(threshold === undefined ? {} : { fullThresholdPercent: threshold }), ...(booksEmptying === undefined ? {} : { booksEmptying }), ...(validTo === undefined ? {} : { validTo }) }
      return Object.keys(change).length === 0 ? refusal("", "Change the threshold, the booking or the last day") : { pairingId, change }
    },
    run: async (client, serverId, body) => {
      const { pairingId, change } = body as { pairingId: string; change: object }
      await patch<SensorPairing>(client, `/sensor-pairings/${pairingId}`, change)
      return await sensorAfter(client, serverId)
    },
    refused: (record) => `${record.name}'s pairing was not changed`,
  },
} satisfies Record<string, RecordCommand<Sensor>>

export const sensorAdapter: ResourceAdapter<Sensor> = {
  prefix: SENSOR_PREFIX,
  auditTable: "sensor",
  owns: hasPrefix(SENSOR_PREFIX),
  statuses: SENSOR_STATUSES,
  list: (client) => listAll<Sensor>(client, "/sensors"),
  toRecord: toSensorRecord,
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const identifier = requiredText(record, "identifier", "A sensor", "an identifier")
    if (isLocalRefusal(identifier)) return identifier
    const network = tokenOf(record, "network", SENSOR_NETWORKS, "network", "a sensor") ?? refusal("network", "Say which network the sensor reports over")
    if (isLocalRefusal(network)) return network
    const status = createStatusOf(record, SENSOR_STATUSES, "a sensor")
    if (isLocalRefusal(status)) return status
    if (status !== undefined && status !== "active") return refusal("status", "A sensor starts active")
    const notes = typed(record, "notes")
    return { projectId, identifier, network, ...(notes === undefined ? {} : { notes }) }
  },
  toPatchBody: (before, after) => {
    if (projectMoved(before, after)) return refusal("projectId", projectSetOnce)
    const network = tokenOf(after, "network", SENSOR_NETWORKS, "network", "a sensor")
    if (isLocalRefusal(network)) return network
    const status = patchStatusOf(before, after, SENSOR_STATUSES, "a sensor")
    if (isLocalRefusal(status)) return status
    return withStatus(
      patchOf(before, after, (record) => ({
        identifier: typed(record, "identifier") ?? record.name,
        network: typed(record, "network"),
        notes: typed(record, "notes") ?? null,
      })),
      before,
      status,
      SENSOR_STATUSES,
    )
  },
  create: (client, body) => create<Sensor>(client, "/sensors", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Sensor>(client, `/sensors/${serverId}`, body),
  read: (client, serverId) => get<Sensor>(client, `/sensors/${serverId}`),
  commands: SENSOR_COMMANDS,
}

/** A sensor's readings, newest recorded first: the first page, read beside the row. */
export const sensorReadings = (client: ApiClient, serverId: string): Promise<FillReading[]> => listPage<FillReading>(client, `/sensors/${serverId}/readings`).then((page) => page.items)

/** Resources › Sensors: the fill-level sensors, read after the containers so a pairing names its container by label. */
export const sensorsModule: ServerModule = {
  workspaceId: SENSORS_MODULE.workspaceId,
  moduleId: SENSORS_MODULE.moduleId,
  resources: [sensorAdapter],
}
