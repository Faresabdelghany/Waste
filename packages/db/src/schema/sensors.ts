// Fill-level Sensors (O26 of #290, row 9.10): a device the company owns, the
// Container it measures over a period, and what it reports.
//
// `sensor` is the project's device, identified by its network identifier —
// unique across the company, since that is the key a vendor's integration
// posts its readings under and it names one device wherever the device
// stands — with the network it reports over and a status: an active sensor
// reports, a retired one is refused at the ingest and paired to no new
// container, and keeps its pairings and readings.
//
// `sensor_pairing` is the sensor on a container: effective-dated and
// half-open (ADR-0005), with the full threshold the worker's alert rule reads.
// Two exclusion constraints, one over the sensor and one over the container:
// a sensor measures one container at a time, and a container is measured by
// one sensor at a time. The pairing is the bin's and not the place's, so it
// names no placement and outlives a move.
//
// `fill_reading` is the ledger of what a sensor sent, appended by the ingest
// and never rewritten. Its pairing is the one in force on the reading's day on
// the project's clock, resolved once at the ingest and null for a sensor
// paired to nothing then; the rule reads a pairing's newest reading through
// it. A sensor and an instant are one reading (`unique`), so a vendor's batch
// sent twice records nothing the second time.
import { SENSOR_NETWORKS, SENSOR_STATUSES } from "@waste/domain/resources/vocabulary"
import { sql } from "drizzle-orm"
import { check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf } from "./checks"
import { id, projectScoped, recorded, timestamps, validity, validPeriod } from "./columns"
import { container } from "./containers"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const sensor = wms.table(
  "sensor",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The device's identifier on its network, a LoRaWAN DevEUI or a Sigfox ID: the key its readings are posted under. */
    identifier: text().notNull(),
    network: text().notNull(),
    status: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantUnique(t, t.identifier),
    projectKey(t),
    oneOf(t.network, SENSOR_NETWORKS),
    oneOf(t.status, SENSOR_STATUSES),
  ],
)

export const sensorPairing = wms.table(
  "sensor_pairing",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    sensorId: uuid().notNull(),
    containerId: uuid().notNull(),
    /** The fill, in whole percent, at which the container is full enough to raise an alert. */
    fullThresholdPercent: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.sensorId], sensor),
    projectReference(t, [t.containerId], container),
    projectKey(t),
    validPeriod(t),
    check(tableObjectName(t.id.table, "threshold_range", "sensorPairing"), sql`${t.fullThresholdPercent} between 1 and 100`),
    // The container's pairings are found through the exclusion constraint's index over (company_id, container_id, the period).
  ],
)

export const fillReading = wms.table(
  "fill_reading",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    sensorId: uuid().notNull(),
    /** The pairing in force on the reading's day, resolved at the ingest; null for a sensor paired to nothing then. */
    pairingId: uuid(),
    /** The sensor's instant for the measurement, not the upload's. */
    measuredAt: timestamp({ withTimezone: true }).notNull(),
    /** Whole percent, as the vendor computed it. */
    fillPercent: integer().notNull(),
    /** Whole percent, where the vendor reports it. */
    batteryPercent: integer(),
    /** Whole dBm, where the vendor reports it. */
    rssiDbm: integer(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.sensorId], sensor),
    projectReference(t, [t.pairingId], sensorPairing),
    // One reading per sensor and instant: a batch sent twice is a replay. Leads with the sensor, so it is the reference's index and a sensor's history in order.
    tenantUnique(t, t.sensorId, t.measuredAt),
    check(tableObjectName(t.id.table, "fill_range", "fillReading"), sql`${t.fillPercent} between 0 and 100`),
    check(tableObjectName(t.id.table, "battery_range", "fillReading"), sql`${t.batteryPercent} is null or ${t.batteryPercent} between 0 and 100`),
    check(tableObjectName(t.id.table, "rssi_range", "fillReading"), sql`${t.rssiDbm} is null or ${t.rssiDbm} between -200 and 0`),
    // A pairing's newest reading, which the alert rule asks for.
    index(tableObjectName(t.companyId.table, "pairing_id_idx", "fillReading")).on(t.companyId, t.pairingId, t.measuredAt),
    tenantIndex(t, t.projectId),
  ],
)
