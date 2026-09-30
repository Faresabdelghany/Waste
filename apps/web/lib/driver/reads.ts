// The driver door as the Driver App calls it (Issue #145): its two readers and
// the one write, over the web's one client (lib/api/client.ts), the shapes
// imported as types only. `GET /driver/me` is the start screen — the driver,
// the open Session, the routes the door bounds (ready or active, or completed
// today) and the lists a start and an unload pick from (#144) — and `GET
// /driver/routes/:id` the route screen, its stops in `sequence` with their
// places joined; `POST /driver/commands` takes the Command Queue's batch.
import type { DriverCommandBatchOutcome, DriverMe, DriverRouteDetail } from "@waste/contracts/driver-commands"

import { command, get, UNREACHABLE_STATUS, type ApiClient } from "../api/client"
import { ApiProblem, genericProblem, type Problem } from "../api/problem"
import type { PilotCommand } from "./commands"

export const readDriverMe = (client: ApiClient): Promise<DriverMe> => get<DriverMe>(client, "/driver/me")

export const readDriverRoute = (client: ApiClient, id: string): Promise<DriverRouteDetail> => get<DriverRouteDetail>(client, `/driver/routes/${encodeURIComponent(id)}`)

export const sendCommands = (client: ApiClient, commands: readonly PilotCommand[]): Promise<DriverCommandBatchOutcome> => command<DriverCommandBatchOutcome>(client, "/driver/commands", { commands })

/** The problem a failed call stands for; anything the client did not throw as one is the server out of reach. */
export function problemOfFailure(error: unknown): Problem {
  return error instanceof ApiProblem ? error.problem : genericProblem(UNREACHABLE_STATUS, error instanceof Error ? error.message : undefined)
}

/**
 * Whether a failure is the server out of reach rather than its answer: no
 * answer at all, a timeout, a rate limit, or a 5xx — which is also what the
 * web's own proxy (next.config.mjs) answers while the API is down. The queue
 * keeps everything and tries again; the banner says "Can't reach the server".
 */
export function outOfReach(status: number): boolean {
  return status === UNREACHABLE_STATUS || status === 408 || status === 429 || status >= 500
}
