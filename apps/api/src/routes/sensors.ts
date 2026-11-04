// Fill-level Sensors (O26 of #290, row 9.10), under `resources.sensors`.
// `GET`/`POST /sensors` list and register a sensor, `GET`/`PATCH
// /sensors/:id` read, correct and retire one, `GET`/`POST
// /sensors/:id/pairings` list and make its pairings with containers, `GET`/
// `PATCH /sensor-pairings/:id` read one and move its threshold or its end,
// `GET /sensors/:id/readings` reads what it sent, and `POST /sensor-readings`
// is the vendor-neutral ingest. No delete: a sensor is retired by its status,
// and a pairing ended by its period, since the readings name both.
//
// No sensor vendor is chosen (decided on #361). The ingest takes a vendor's
// batch by each sensor's identifier — unique across the company, the key a
// vendor knows a device by — with the fill already a whole percent, since a
// sensor's offset and a lid's geometry are the vendor's arithmetic; the
// integration signs in as a Login on the Integration Writer role, which views
// and creates here. Each reading is judged alone and answered in the body's
// order, the bulk dispatch's shape (O5 of #290): a sensor no project of the
// caller's has is `unknown-sensor`, a retired one `retired-sensor`, an
// instant ahead of the request's clock beyond `OCCURRED_AT_SKEW_MS`
// `ahead-of-clock`, and a sensor's reading at an instant the ledger already
// holds `replayed` with that row's id — so a vendor that resends a batch
// records nothing twice. A reading is tied to the pairing in force on its
// day on the project's clock, resolved here once, and to none where the
// sensor measured nothing that day; the worker's `fill-threshold` rule reads
// a pairing's newest reading through it (apps/worker's alert-rules job).
//
// A Sensor answers two readings beside its own fields, read on every request:
// the pairing in force today on its project's clock and its newest reading.
// A page reads both for its sensors in two statements, not two per row.
//
// The pairing's rules: the sensor is the path's and the container must be of
// its project (400); a retired sensor is paired to nothing new (409, a status
// gating a new reference, routes/statuses.ts); one sensor measures one
// container at a time and one container is measured by one sensor at a time,
// the database's two exclusion constraints (23P01, `refuseOverlap`). A
// sensor is retired only once no pairing of it is open on or after today
// (409 counting them), so a retired sensor measures nothing.
//
// The ingest is no open door: it needs a token and `create` on
// `resources.sensors` like every write, it reaches only the sensors of the
// caller's company in the projects the caller works in (any other identifier
// is `unknown-sensor`), and it is bounded twice — a body of at most
// `SENSOR_READINGS_MAX_BYTES`, refused as a 413 before the token is read, and
// `SENSOR_BATCHES_PER_MINUTE` batches a minute per company, a 429 with
// Retry-After beyond it, counted per API instance as the public door's
// allowance is.
import { Page } from "@waste/contracts/pagination"
import {
  FillReading,
  FillReadingBatch,
  FillReadingResults,
  Sensor,
  SensorCreate,
  SensorListQuery,
  SensorPairing,
  SensorPairingCreate,
  SensorPairingPatch,
  SensorPatch,
  type FillReadingOutcome,
  type SensorNetwork,
  type SensorStatus,
} from "@waste/contracts/sensors"
import type { Tx } from "@waste/db/client"
import { dayInTimezone } from "@waste/db/commands/days"
import { project } from "@waste/db/schema/organisation"
import { fillReading, sensor, sensorPairing } from "@waste/db/schema/sensors"
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { periodAfter, requireOrdered } from "./periods"
import { requireContainer } from "./references"
import { Allowance } from "../auth/public-door"
import { created, describeCreated, describeJson, IdParam, lockRow, OCCURRED_AT_SKEW_MS, refuseDuplicate, refuseOverlap, stampsOf, strengthFor } from "./shared"

const MODULE = "resources.sensors"

/** The largest ingest body: 500 readings of the widest shape the contracts take fit inside it. */
export const SENSOR_READINGS_MAX_BYTES = 256 * 1024
/** A company's ingest batches a minute on one API instance: a vendor flushing its queue every few seconds stays well inside it. */
export const SENSOR_BATCHES_PER_MINUTE = 120

const SensorPage = Page(Sensor)
const PairingPage = Page(SensorPairing)
const ReadingPage = Page(FillReading)

const sensorColumns = {
  id: sensor.id,
  projectId: sensor.projectId,
  identifier: sensor.identifier,
  network: sensor.network,
  status: sensor.status,
  notes: sensor.notes,
  createdAt: sensor.createdAt,
  updatedAt: sensor.updatedAt,
}
type SensorRow = Pick<typeof sensor.$inferSelect, keyof typeof sensorColumns>

const pairingColumns = {
  id: sensorPairing.id,
  projectId: sensorPairing.projectId,
  sensorId: sensorPairing.sensorId,
  containerId: sensorPairing.containerId,
  fullThresholdPercent: sensorPairing.fullThresholdPercent,
  booksEmptying: sensorPairing.booksEmptying,
  validFrom: sensorPairing.validFrom,
  validTo: sensorPairing.validTo,
  createdAt: sensorPairing.createdAt,
  updatedAt: sensorPairing.updatedAt,
}
type PairingRow = Pick<typeof sensorPairing.$inferSelect, keyof typeof pairingColumns>

const pairingOf = (row: PairingRow): SensorPairing => ({
  id: row.id,
  projectId: row.projectId,
  sensorId: row.sensorId,
  containerId: row.containerId,
  fullThresholdPercent: row.fullThresholdPercent,
  booksEmptying: row.booksEmptying,
  validFrom: row.validFrom,
  validTo: row.validTo,
  ...stampsOf(row),
})

/** A reading as the wire spells it, its container read through its pairing. */
const readingColumns = {
  id: fillReading.id,
  projectId: fillReading.projectId,
  sensorId: fillReading.sensorId,
  pairingId: fillReading.pairingId,
  containerId: sensorPairing.containerId,
  measuredAt: fillReading.measuredAt,
  fillPercent: fillReading.fillPercent,
  batteryPercent: fillReading.batteryPercent,
  rssiDbm: fillReading.rssiDbm,
  recordedAt: fillReading.recordedAt,
}
type ReadingRow = Pick<typeof fillReading.$inferSelect, "id" | "projectId" | "sensorId" | "pairingId" | "measuredAt" | "fillPercent" | "batteryPercent" | "rssiDbm" | "recordedAt"> & { containerId: string | null }

const readingOf = (row: ReadingRow): FillReading => ({
  id: row.id,
  projectId: row.projectId,
  sensorId: row.sensorId,
  pairingId: row.pairingId,
  containerId: row.containerId,
  measuredAt: row.measuredAt.toISOString(),
  fillPercent: row.fillPercent,
  batteryPercent: row.batteryPercent,
  rssiDbm: row.rssiDbm,
  recordedAt: row.recordedAt.toISOString(),
})

/** The readings, each with its pairing joined for the container, inside the company. */
const readingsFrom = (tx: Tx, companyId: string) =>
  tx
    .select(readingColumns)
    .from(fillReading)
    .leftJoin(sensorPairing, and(eq(sensorPairing.companyId, companyId), eq(sensorPairing.id, fillReading.pairingId)))

/** `unique (company_id, identifier)`: an identifier is one device's across the company. */
const IDENTIFIER_TAKEN = "sensor_identifier_key"
const identifierTaken = (identifier: string) => `This company already has a sensor ${JSON.stringify(identifier)}`

/** The pairing's two exclusion constraints, one over the sensor and one over the container. */
const SENSOR_PAIRED = "sensor_pairing_no_overlap"
const CONTAINER_PAIRED = "sensor_pairing_container_no_overlap"
const OVERLAPS = {
  [SENSOR_PAIRED]: "The sensor is paired with another container over part of that period; end that pairing first",
  [CONTAINER_PAIRED]: "The container is measured by another sensor over part of that period; end that pairing first",
}

/** What pairing a retired sensor is told. */
export const RETIRED_SENSOR = "The sensor is retired; only an active sensor is paired with a container"
/** What retiring a sensor still measuring is told. */
export const stillPaired = (open: number): string =>
  `The sensor has ${open === 1 ? "a pairing" : `${open} pairings`} open on or after today; end ${open === 1 ? "it" : "them"} before retiring the sensor`

const noSuchSensor = (id: string) => problem(404, { detail: `No sensor ${id} in the projects this account works in` })
const noSuchPairing = (id: string) => problem(404, { detail: `No sensor pairing ${id} in the projects this account works in` })

const sensorScope = (principal: Principal) => and(eq(sensor.companyId, principal.companyId), inProjects(sensor.projectId, principal))
const pairingScope = (principal: Principal) => and(eq(sensorPairing.companyId, principal.companyId), inProjects(sensorPairing.projectId, principal))

/** Each project's timezone, for the projects named: what "today" is read on. */
async function timezonesOf(tx: Tx, companyId: string, projectIds: readonly string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map()
  const rows = await tx
    .select({ id: project.id, timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), inArray(project.id, [...new Set(projectIds)])))
  return new Map(rows.map((row) => [row.id, row.timezone]))
}

/** Whether a period holds a day: on or after its start and before its first day out. */
const holds = (period: { validFrom: string; validTo: string | null }, day: string): boolean => period.validFrom <= day && (period.validTo === null || day < period.validTo)

/**
 * The sensors as the wire spells them: the pairing in force today on each
 * one's project's clock, and each one's newest reading, two statements for
 * the whole page. The pairings read are those that could hold some
 * project's today — the earliest and the latest today bound them — and each
 * sensor keeps the one that holds its own.
 */
async function sensorsOf(tx: Tx, companyId: string, rows: readonly SensorRow[], at: Date): Promise<Sensor[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const zones = await timezonesOf(tx, companyId, rows.map((row) => row.projectId))
  const today = (projectId: string) => dayInTimezone(at, zones.get(projectId) ?? "UTC")
  const days = rows.map((row) => today(row.projectId)).sort()
  const [earliest, latest] = [days[0]!, days.at(-1)!]
  const pairings = await tx
    .select(pairingColumns)
    .from(sensorPairing)
    .where(and(eq(sensorPairing.companyId, companyId), inArray(sensorPairing.sensorId, ids), lte(sensorPairing.validFrom, latest), or(isNull(sensorPairing.validTo), gt(sensorPairing.validTo, earliest))))
  const latestReadings = await tx
    .selectDistinctOn([fillReading.sensorId], readingColumns)
    .from(fillReading)
    .leftJoin(sensorPairing, and(eq(sensorPairing.companyId, companyId), eq(sensorPairing.id, fillReading.pairingId)))
    .where(and(eq(fillReading.companyId, companyId), inArray(fillReading.sensorId, ids)))
    .orderBy(fillReading.sensorId, desc(fillReading.measuredAt))
  const newest = new Map(latestReadings.map((row) => [row.sensorId, row]))
  return rows.map((row) => {
    const inForce = pairings.find((pairing) => pairing.sensorId === row.id && holds(pairing, today(row.projectId)))
    const reading = newest.get(row.id)
    return {
      id: row.id,
      projectId: row.projectId,
      identifier: row.identifier,
      network: row.network as SensorNetwork,
      status: row.status as SensorStatus,
      notes: row.notes,
      pairing: inForce === undefined ? null : pairingOf(inForce),
      lastReading: reading === undefined ? null : readingOf(reading),
      ...stampsOf(row),
    }
  })
}

async function findSensor(tx: Tx, principal: Principal, id: string): Promise<SensorRow | undefined> {
  const [row] = await tx
    .select(sensorColumns)
    .from(sensor)
    .where(and(sensorScope(principal), eq(sensor.id, id)))
    .limit(1)
  return row
}

async function findPairing(tx: Tx, principal: Principal, id: string): Promise<PairingRow | undefined> {
  const [row] = await tx
    .select(pairingColumns)
    .from(sensorPairing)
    .where(and(pairingScope(principal), eq(sensorPairing.id, id)))
    .limit(1)
  return row
}

/** The pairings of a sensor open on or after a day: what a retirement would leave measuring. */
async function openPairings(tx: Tx, companyId: string, sensorId: string, day: string): Promise<number> {
  const [row] = await tx
    .select({ open: sql<number>`count(*)::int` })
    .from(sensorPairing)
    .where(and(eq(sensorPairing.companyId, companyId), eq(sensorPairing.sensorId, sensorId), or(isNull(sensorPairing.validTo), gt(sensorPairing.validTo, day))))
  return row?.open ?? 0
}

/** A reading of the batch with what the ingest resolved for it. */
type Known = { id: string; projectId: string; status: string }

/**
 * The ingest: each reading judged alone, in the body's order. The sensors are
 * read once for the batch by identifier inside the caller's projects, their
 * projects' timezones once, and their pairings over the batch's days once; a
 * reading is then appended with `on conflict do nothing` over the sensor and
 * the instant, and a reading the ledger already holds is answered with that
 * row's id.
 */
async function ingest(tx: Tx, principal: Principal, batch: FillReadingBatch, at: Date): Promise<FillReadingOutcome[]> {
  const { companyId } = principal
  const identifiers = [...new Set(batch.readings.map((reading) => reading.sensorIdentifier))]
  const sensors = await tx
    .select({ id: sensor.id, projectId: sensor.projectId, status: sensor.status, identifier: sensor.identifier })
    .from(sensor)
    .where(and(sensorScope(principal), inArray(sensor.identifier, identifiers)))
  const byIdentifier = new Map<string, Known>(sensors.map((row) => [row.identifier, row]))
  const zones = await timezonesOf(tx, companyId, sensors.map((row) => row.projectId))
  const dayOf = (known: Known, measuredAt: string) => dayInTimezone(new Date(measuredAt), zones.get(known.projectId) ?? "UTC")
  const active = sensors.filter((row) => row.status === "active").map((row) => row.id)
  const pairings =
    active.length === 0
      ? []
      : await tx
          .select({ id: sensorPairing.id, sensorId: sensorPairing.sensorId, validFrom: sensorPairing.validFrom, validTo: sensorPairing.validTo })
          .from(sensorPairing)
          .where(and(eq(sensorPairing.companyId, companyId), inArray(sensorPairing.sensorId, active)))
  const outcomes: FillReadingOutcome[] = []
  for (const reading of batch.readings) {
    const known = byIdentifier.get(reading.sensorIdentifier)
    if (known === undefined) {
      outcomes.push({ outcome: "refused", reason: "unknown-sensor", detail: `No sensor ${JSON.stringify(reading.sensorIdentifier)} in the projects this account works in` })
      continue
    }
    if (known.status !== "active") {
      outcomes.push({ outcome: "refused", reason: "retired-sensor", detail: `The sensor ${JSON.stringify(reading.sensorIdentifier)} is retired; its readings are not recorded` })
      continue
    }
    const measuredAt = new Date(reading.measuredAt)
    if (measuredAt.getTime() > at.getTime() + OCCURRED_AT_SKEW_MS) {
      outcomes.push({ outcome: "refused", reason: "ahead-of-clock", detail: `Measured at ${reading.measuredAt}, after the server's clock; a reading is recorded after it is taken` })
      continue
    }
    const day = dayOf(known, reading.measuredAt)
    const pairing = pairings.find((candidate) => candidate.sensorId === known.id && holds(candidate, day))
    const [written] = await tx
      .insert(fillReading)
      .values({
        id: newId(),
        companyId,
        projectId: known.projectId,
        sensorId: known.id,
        pairingId: pairing?.id ?? null,
        measuredAt,
        fillPercent: reading.fillPercent,
        batteryPercent: reading.batteryPercent ?? null,
        rssiDbm: reading.rssiDbm ?? null,
      })
      .onConflictDoNothing({ target: [fillReading.companyId, fillReading.sensorId, fillReading.measuredAt] })
      .returning({ id: fillReading.id })
    if (written !== undefined) {
      outcomes.push({ outcome: "recorded", id: written.id })
      continue
    }
    const [already] = await tx
      .select({ id: fillReading.id })
      .from(fillReading)
      .where(and(eq(fillReading.companyId, companyId), eq(fillReading.sensorId, known.id), eq(fillReading.measuredAt, measuredAt)))
      .limit(1)
    outcomes.push({ outcome: "replayed", id: already!.id })
  }
  return outcomes
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export type SensorRouteOptions = { now?: () => Date; ingestAllowance?: Allowance }

export function sensorRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date(), ingestAllowance = new Allowance(SENSOR_BATCHES_PER_MINUTE, now) }: SensorRouteOptions = {}) {
  /** The company's batch counted against its allowance, after the guard has said whose it is. */
  const withinAllowance: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const taken = ingestAllowance.take(c.get("principal").companyId)
    if (!taken.allowed) {
      throw problem(429, {
        detail: `Too many reading batches from this company; send again in ${taken.retryAfterSeconds} s`,
        headers: { "Retry-After": String(taken.retryAfterSeconds) },
      })
    }
    await next()
  }
  return new Hono<AuthEnv>()
    .get(
      "/sensors",
      describeRoute({
        operationId: "listSensors",
        summary: "The fill-level sensors",
        description:
          "One page of the sensors in the projects the caller works in, oldest first (ids are time-ordered), each with the pairing in force today on its project's clock and its newest reading. `projectId` and `status` narrow the page. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of sensors.", SensorPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, the project is not one the caller works in, or the status is not one of the two."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", SensorListQuery),
      async (c) => {
        const { limit, cursor, projectId, status } = c.req.valid("query")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const rows = await tx
          .select(sensorColumns)
          .from(sensor)
          .where(
            and(
              sensorScope(principal),
              projectId === undefined ? undefined : eq(sensor.projectId, projectId),
              status === undefined ? undefined : eq(sensor.status, status),
              after === undefined ? undefined : gt(sensor.id, after),
            ),
          )
          .orderBy(asc(sensor.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: await sensorsOf(tx, principal.companyId, page.items, now()) })
      },
    )
    .post(
      "/sensors",
      describeRoute({
        operationId: "createSensor",
        summary: "Register a sensor",
        description:
          "Registers a fill-level sensor in a project the caller works in, by its network identifier — unique across the company, the key its readings are posted under — and its network. A sensor starts active. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The sensor as it was written, on no container yet.", Sensor),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, names a member the server owns, or names a project the caller does not work in."),
          ...commonProblems("create"),
          409: describeProblem("The company already has a sensor with that identifier."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", SensorCreate),
      async (c) => {
        const values = c.req.valid("json")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const tx = c.get("tx")
        const [row] = await refuseDuplicate({ [IDENTIFIER_TAKEN]: identifierTaken(values.identifier) }, () =>
          tx
            .insert(sensor)
            .values({ ...values, id: newId(), companyId: principal.companyId, status: "active" })
            .returning(sensorColumns),
        )
        const [answer] = await sensorsOf(tx, principal.companyId, [row], now())
        return created(c, "/sensors", answer!)
      },
    )
    .get(
      "/sensors/:id",
      describeRoute({
        operationId: "getSensor",
        summary: "One sensor",
        description: "One sensor of the projects the caller works in, with the pairing in force today on its project's clock and its newest reading.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The sensor.", Sensor),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No sensor with that id in the projects the caller works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        const tx = c.get("tx")
        const row = await findSensor(tx, principal, id)
        if (row === undefined) throw noSuchSensor(id)
        const [answer] = await sensorsOf(tx, principal.companyId, [row], now())
        return c.json(answer!)
      },
    )
    .patch(
      "/sensors/:id",
      describeRoute({
        operationId: "patchSensor",
        summary: "Correct or retire a sensor",
        description:
          "Corrects the identifier, the network or the note, or changes the status: `retired` refuses the sensor's readings and pairs it with no new container, and is taken only once no pairing of it is open on or after today on the project's clock; `active` takes it back. A sensor does not move between projects.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The sensor as it now stands.", Sensor),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own."),
          ...commonProblems("edit"),
          404: describeProblem("No sensor with that id in the projects the caller works in."),
          409: describeProblem("The company already has another sensor with that identifier, or a retirement would leave a pairing open."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SensorPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const principal = c.get("principal")
        const tx = c.get("tx")
        if ((await findSensor(tx, principal, id)) === undefined) throw noSuchSensor(id)
        await lockRow(tx, sensor, { companyId: principal.companyId, id }, strengthFor(sensor, patch))
        const found = (await findSensor(tx, principal, id))!
        if (patch.status === "retired" && found.status !== "retired") {
          const zones = await timezonesOf(tx, principal.companyId, [found.projectId])
          const open = await openPairings(tx, principal.companyId, id, dayInTimezone(now(), zones.get(found.projectId) ?? "UTC"))
          if (open > 0) throw problem(409, { detail: stillPaired(open) })
        }
        const sentences: Record<string, string> = patch.identifier === undefined ? {} : { [IDENTIFIER_TAKEN]: identifierTaken(patch.identifier) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(sensor)
            .set(patch)
            .where(and(eq(sensor.companyId, principal.companyId), eq(sensor.id, id)))
            .returning(sensorColumns),
        )
        const [answer] = await sensorsOf(tx, principal.companyId, [row!], now())
        return c.json(answer!)
      },
    )
    .get(
      "/sensors/:id/pairings",
      describeRoute({
        operationId: "listSensorPairings",
        summary: "A sensor's pairings",
        description: "One page of the containers the sensor has measured, measures and will measure, oldest first. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the sensor's pairings.", PairingPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          ...commonProblems("view"),
          404: describeProblem("No sensor with that id in the projects the caller works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", SensorListQuery.pick({ limit: true, cursor: true })),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const principal = c.get("principal")
        const tx = c.get("tx")
        if ((await findSensor(tx, principal, id)) === undefined) throw noSuchSensor(id)
        const after = afterCursor(cursor)
        const rows = await tx
          .select(pairingColumns)
          .from(sensorPairing)
          .where(and(pairingScope(principal), eq(sensorPairing.sensorId, id), after === undefined ? undefined : gt(sensorPairing.id, after)))
          .orderBy(asc(sensorPairing.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: page.items.map(pairingOf) })
      },
    )
    .post(
      "/sensors/:id/pairings",
      describeRoute({
        operationId: "createSensorPairing",
        summary: "Pair a sensor with a container",
        description:
          "Has the sensor measure a container of its project over a half-open period, at a full threshold in whole percent (85 unless said), the fill at which the worker's `fill-threshold` rule raises an alert. With `booksEmptying` the alert also books the office's emptying of the container on the next route of its round ahead of its next scheduled emptying, where one runs and its vehicle takes the bin; the alert says what it came to. One sensor measures one container at a time and one container is measured by one sensor at a time. A retired sensor is paired with nothing new.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The pairing as it was written, read at `/sensor-pairings/{id}`.", SensorPairing),
          400: describeProblem("The path does not hold an id, or the body is missing a field, holds a value of the wrong shape, names a member the server owns, runs its period backwards, or names a container outside the sensor's project."),
          ...commonProblems("create"),
          404: describeProblem("No sensor with that id in the projects the caller works in."),
          409: describeProblem("The sensor is retired, or the sensor or the container is already paired over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", SensorPairingCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const principal = c.get("principal")
        const tx = c.get("tx")
        if ((await findSensor(tx, principal, id)) === undefined) throw noSuchSensor(id)
        // The sensor's lock before its status is read: a retirement and a new pairing do not pass each other.
        await lockRow(tx, sensor, { companyId: principal.companyId, id })
        const found = (await findSensor(tx, principal, id))!
        const within = { companyId: principal.companyId, projectId: found.projectId }
        await requireContainer(tx, within, values.containerId)
        // Every 400 above, every 409 below (routes/statuses.ts).
        if (found.status !== "active") throw problem(409, { detail: RETIRED_SENSOR })
        const [row] = await refuseOverlap(OVERLAPS, () =>
          tx
            .insert(sensorPairing)
            .values({ ...values, validTo: values.validTo ?? null, id: newId(), companyId: principal.companyId, projectId: found.projectId, sensorId: id })
            .returning(pairingColumns),
        )
        return created(c, "/sensor-pairings", pairingOf(row!))
      },
    )
    .get(
      "/sensor-pairings/:id",
      describeRoute({
        operationId: "getSensorPairing",
        summary: "One sensor pairing",
        description: "One pairing of a sensor with a container, in the projects the caller works in.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pairing.", SensorPairing),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No sensor pairing with that id in the projects the caller works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findPairing(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchPairing(id)
        return c.json(pairingOf(row))
      },
    )
    .patch(
      "/sensor-pairings/:id",
      describeRoute({
        operationId: "patchSensorPairing",
        summary: "Move a pairing's threshold, its booking or its end",
        description:
          "Moves the full threshold, whether a filling books an emptying, or the first day the sensor no longer measures the container (`validTo`; null leaves the pairing open). A pairing that starts on another day or measures another container is another pairing. An end taken later is held to the same rule as a create: the sensor and the container each paired once at a time.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pairing as it now stands.", SensorPairing),
          400: describeProblem("The path does not hold an id, the patch is empty or names a field the caller does not own, or the end comes on or before the start."),
          ...commonProblems("edit"),
          404: describeProblem("No sensor pairing with that id in the projects the caller works in."),
          409: describeProblem("The end taken later overlaps another pairing of the sensor or of the container."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SensorPairingPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const principal = c.get("principal")
        const tx = c.get("tx")
        const found = await findPairing(tx, principal, id)
        if (found === undefined) throw noSuchPairing(id)
        await lockRow(tx, sensor, { companyId: principal.companyId, id: found.sensorId })
        await lockRow(tx, sensorPairing, { companyId: principal.companyId, id })
        requireOrdered(periodAfter(found, patch))
        const [row] = await refuseOverlap(OVERLAPS, () =>
          tx
            .update(sensorPairing)
            .set(patch)
            .where(and(eq(sensorPairing.companyId, principal.companyId), eq(sensorPairing.id, id)))
            .returning(pairingColumns),
        )
        return c.json(pairingOf(row!))
      },
    )
    .get(
      "/sensors/:id/readings",
      describeRoute({
        operationId: "listSensorReadings",
        summary: "What a sensor read",
        description:
          "One page of the sensor's readings, newest recorded first, each with the pairing in force on its day and that pairing's container. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the sensor's readings.", ReadingPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          ...commonProblems("view"),
          404: describeProblem("No sensor with that id in the projects the caller works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", SensorListQuery.pick({ limit: true, cursor: true })),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const principal = c.get("principal")
        const tx = c.get("tx")
        if ((await findSensor(tx, principal, id)) === undefined) throw noSuchSensor(id)
        const after = afterCursor(cursor)
        const rows = await readingsFrom(tx, principal.companyId)
          .where(and(eq(fillReading.companyId, principal.companyId), eq(fillReading.sensorId, id), after === undefined ? undefined : lt(fillReading.id, after)))
          .orderBy(desc(fillReading.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: page.items.map(readingOf) })
      },
    )
    .post(
      "/sensor-readings",
      describeRoute({
        operationId: "recordSensorReadings",
        summary: "Record a batch of fill readings",
        description:
          "The vendor-neutral ingest, under a token with `create` on `resources.sensors`, at most 256 KiB and 120 batches a minute per company: up to 500 readings by each sensor's identifier, the fill a whole percent the vendor computed, the battery and the signal strength where it reports them. Each reading is judged alone and answered in the body's order: `recorded` with the ledger row's id; `replayed` with the row's id when the sensor's reading at that instant is already recorded, so a batch sent twice records nothing twice; or `refused` with why — `unknown-sensor` (no sensor of that identifier in the caller's projects), `retired-sensor`, or `ahead-of-clock` (measured more than five minutes after the server's clock). A reading is tied to the pairing in force on its day on the project's clock, and to none where the sensor measured nothing that day.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One outcome per reading, in the body's order.", FillReadingResults),
          400: describeProblem("The body is not a batch of one to 500 readings of the right shape."),
          ...commonProblems("create"),
          413: describeProblem("The body is larger than 256 KiB."),
          429: describeProblem("The company has sent more batches this minute than the ingest takes; Retry-After says when to send again."),
        },
      }),
      bodyLimit({
        maxSize: SENSOR_READINGS_MAX_BYTES,
        onError: () => {
          throw problem(413, { detail: `A batch of readings is at most ${SENSOR_READINGS_MAX_BYTES / 1024} KiB` })
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      withinAllowance,
      validate("json", FillReadingBatch),
      async (c) => {
        const batch = c.req.valid("json")
        const results = await ingest(c.get("tx"), c.get("principal"), batch, now())
        return c.json({ results } satisfies FillReadingResults)
      },
    )
}
