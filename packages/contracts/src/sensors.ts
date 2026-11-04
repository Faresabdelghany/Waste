// Fill-level Sensors on the wire (O26 of #290, row 9.10): a device the
// company owns, the Container it measures over a period, and the readings it
// sends through the vendor-neutral ingest.
//
// A Sensor is identified by its network identifier, unique across the
// company, which is the key a vendor's integration posts readings under. It
// carries two readings beside its own fields, read on every request and in no
// write body: `pairing`, the pairing in force today on the project's clock,
// null for a sensor on no container today, and `lastReading`, its newest
// reading, null before the first. A sensor is never deleted: it is retired
// (`status`), when its readings are refused and it is paired to no new
// container.
//
// A Sensor Pairing is effective-dated and half-open (ADR-0005): the sensor is
// the path's (`POST /sensors/:id/pairings`) and the project is the sensor's,
// so the body names the container and the period and the full threshold, a
// whole percent from 1 to 100, 85 when absent, and whether a filling books
// the office's emptying of the container (`booksEmptying`, off when
// absent; O26's second part). One sensor measures one
// container at a time and one container is measured by one sensor at a time,
// which the database's two exclusion constraints hold. A patch moves the
// threshold or the end; a pairing that starts on another day or measures
// another container is another pairing.
//
// The ingest, `POST /sensor-readings`, takes a vendor's batch of up to
// `SENSOR_READING_BATCH_MAX` readings by the sensor's identifier, and answers
// one outcome per reading in the body's order: `recorded`, `replayed` (the
// sensor's reading at that instant is already in the ledger), or `refused`
// with the reason. A batch never fails whole for one reading it cannot take.
// The fill is a whole percent the vendor computed; the battery and the signal
// strength are where the vendor reports them.
import { DEFAULT_FULL_THRESHOLD_PERCENT, SENSOR_READING_BATCH_MAX } from "@waste/domain/resources/sensors"
import { SENSOR_NETWORKS, SENSOR_STATUSES } from "@waste/domain/resources/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, recorded, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

export const SensorNetwork = z.enum(SENSOR_NETWORKS)
export type SensorNetwork = z.infer<typeof SensorNetwork>

export const SensorStatus = z.enum(SENSOR_STATUSES)
export type SensorStatus = z.infer<typeof SensorStatus>

/** A whole percent of a container's volume. */
export const Percent = z.int().min(0).max(100)
/** A full threshold: a whole percent above nothing. */
export const ThresholdPercent = z.int().min(1).max(100)
/** A signal strength in whole dBm, as the vendor reports it. */
export const RssiDbm = z.int().min(-200).max(0)

export const SensorPairing = z
  .object({
    ...stamped,
    projectId: Id,
    sensorId: Id,
    containerId: Id,
    /** The fill, in whole percent, at which the container is full enough to raise an alert. */
    fullThresholdPercent: ThresholdPercent,
    /** Whether a filling books the office's emptying of the container ahead of its next scheduled one. Absent on an answer from before it, read as false. */
    booksEmptying: z.boolean().default(false),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type SensorPairing = z.infer<typeof SensorPairing>

export const FillReading = z.object({
  ...recorded,
  projectId: Id,
  sensorId: Id,
  /** The pairing in force on the reading's day; null for a sensor paired to nothing then. */
  pairingId: Id.nullable(),
  /** The container that pairing measures, read through it; null with it. */
  containerId: Id.nullable(),
  /** The sensor's instant for the measurement. */
  measuredAt: IsoDateTime,
  fillPercent: Percent,
  batteryPercent: Percent.nullable(),
  rssiDbm: RssiDbm.nullable(),
})
export type FillReading = z.infer<typeof FillReading>

export const Sensor = z.object({
  ...stamped,
  projectId: Id,
  /** The device's identifier on its network, a LoRaWAN DevEUI or a Sigfox ID: unique per company, the key its readings are posted under. */
  identifier: Label,
  network: SensorNetwork,
  status: SensorStatus,
  notes: Paragraph.nullable(),
  /** The pairing in force today on the project's clock; null for a sensor on no container today. Read, never written. */
  pairing: SensorPairing.nullable(),
  /** The newest reading; null before the first. Read, never written. */
  lastReading: FillReading.nullable(),
})
export type Sensor = z.infer<typeof Sensor>

export const SensorCreate = z.strictObject({
  projectId: Id,
  identifier: Label,
  network: SensorNetwork,
  notes: Paragraph.nullable().optional(),
})
export type SensorCreate = z.infer<typeof SensorCreate>

/** Corrects a sensor, or retires it; a sensor does not move between projects. */
export const SensorPatch = z
  .strictObject({
    identifier: Label.optional(),
    network: SensorNetwork.optional(),
    status: SensorStatus.optional(),
    notes: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type SensorPatch = z.infer<typeof SensorPatch>

/** `POST /sensors/:id/pairings`: the sensor is the path's and the project the sensor's. */
export const SensorPairingCreate = z
  .strictObject({
    containerId: Id,
    fullThresholdPercent: ThresholdPercent.default(DEFAULT_FULL_THRESHOLD_PERCENT).describe(`Defaults to ${DEFAULT_FULL_THRESHOLD_PERCENT} when absent.`),
    booksEmptying: z.boolean().default(false).describe("Off when absent: a pairing books no stop until the office asks."),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type SensorPairingCreate = z.infer<typeof SensorPairingCreate>

/** Moves a pairing's threshold, whether it books an emptying, or its end; null takes the end off. */
export const SensorPairingPatch = z
  .strictObject({
    fullThresholdPercent: ThresholdPercent.optional(),
    booksEmptying: z.boolean().optional(),
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type SensorPairingPatch = z.infer<typeof SensorPairingPatch>

/** A page of sensors: one project's, in one status. */
export const SensorListQuery = ProjectScopedListQuery.extend({
  status: SensorStatus.optional(),
})
export type SensorListQuery = z.infer<typeof SensorListQuery>

/** One reading of a vendor's batch, by the sensor's identifier. */
export const FillReadingIn = z.strictObject({
  sensorIdentifier: Label,
  measuredAt: IsoDateTime,
  fillPercent: Percent,
  batteryPercent: Percent.nullable().optional(),
  rssiDbm: RssiDbm.nullable().optional(),
})
export type FillReadingIn = z.infer<typeof FillReadingIn>

/** `POST /sensor-readings`: a vendor's batch, at least one reading and at most the domain's cap. */
export const FillReadingBatch = z.strictObject({
  readings: z.array(FillReadingIn).min(1).max(SENSOR_READING_BATCH_MAX),
})
export type FillReadingBatch = z.infer<typeof FillReadingBatch>

/** Why the ingest refused a reading: no active sensor of the caller's projects has the identifier, the sensor is retired, or the reading is from the future. */
export const FILL_READING_REFUSALS = ["unknown-sensor", "retired-sensor", "ahead-of-clock"] as const
export const FillReadingRefusal = z.enum(FILL_READING_REFUSALS)
export type FillReadingRefusal = z.infer<typeof FillReadingRefusal>

/** One reading's outcome, in the body's order: recorded or replayed with the ledger row's id, or refused with why. */
export const FillReadingOutcome = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("recorded"), id: Id }),
  z.object({ outcome: z.literal("replayed"), id: Id }),
  z.object({ outcome: z.literal("refused"), reason: FillReadingRefusal, detail: z.string() }),
])
export type FillReadingOutcome = z.infer<typeof FillReadingOutcome>

export const FillReadingResults = z.object({
  results: z.array(FillReadingOutcome),
})
export type FillReadingResults = z.infer<typeof FillReadingResults>
