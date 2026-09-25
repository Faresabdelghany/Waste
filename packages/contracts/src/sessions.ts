// The Session on the wire (Issue #104): a driver-app work session on an
// assigned Route — one Route, one device, one driver, from `start-route` to
// `end-route` (#104 §7.3). It is minted by the device (its id is the start
// command's), never created by a form, and carries current state and no
// status (§7.4): open or ended is a reading of `endedAt`, paused of
// `pausedAt`, and freshness of `lastSeenAt` against now. There is no write
// body here: the device's commands move it, and the office reads it.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { stamped } from "./resource"
import { Label } from "./text"

export const Session = z.object({
  ...stamped,
  projectId: Id,
  routeId: Id,
  driverId: Id,
  vehicleId: Id,
  /** A vehicle of kind trailer, where one went out. */
  trailerId: Id.nullable(),
  /** The installation's stable id the app mints once. */
  deviceId: Label,
  appVersion: Label.nullable(),
  /** The start command's instant. */
  startedAt: IsoDateTime,
  /** The end command's instant; null while the session runs. */
  endedAt: IsoDateTime.nullable(),
  /** Set by pause, cleared by resume: Live's "Paused". */
  pausedAt: IsoDateTime.nullable(),
  /** Moved by every batch the device uploads. */
  lastSeenAt: IsoDateTime,
})
export type Session = z.infer<typeof Session>

/** A page of sessions: one project's, one route's, one driver's, the open ones or the ended ones. */
export const SessionListQuery = ProjectScopedListQuery.extend({
  routeId: Id.optional(),
  driverId: Id.optional(),
  /** `true` for the sessions still running, `false` for the ended ones; absent is both. */
  open: z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }).optional(),
})
export type SessionListQuery = z.infer<typeof SessionListQuery>
