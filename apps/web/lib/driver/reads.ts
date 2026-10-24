// The driver door as the Driver App calls it (Issue #145): its two readers and
// the one write, over the web's one client (lib/api/client.ts), the shapes
// imported as types only. `GET /driver/me` is the start screen — the driver,
// the open Session, the routes the door bounds (ready or active, or completed
// today) and the lists a start and an unload pick from (#144) — and `GET
// /driver/routes/:id` the route screen, its stops in `sequence` with their
// places joined; `POST /driver/commands` takes the Command Queue's batch.
//
// A photo's or a signature's bytes (O1 of #290): `POST /driver/uploads` names
// the object's key and signs an upload URL for it, and the bytes go to that
// URL — Storage, another origin than the API's, and no token of the API's
// with them, the URL being the permission.
import type { DriverCommandBatchOutcome, DriverMe, DriverRouteDetail } from "@waste/contracts/driver-commands"
import type { ProofUpload, ProofUploadRequest } from "@waste/contracts/proof-objects"

import { command, get, UNREACHABLE_STATUS, type ApiClient } from "../api/client"
import { ApiProblem, genericProblem } from "../api/problem"
import type { PilotCommand, ProofBytes } from "./commands"

/** The `type` of the API's 503 for a deployment that holds no Storage key: the contracts' `NO_PROOF_STORAGE.type`, spelled again so no zod reaches the browser, and held equal to it by a test. */
export const NO_PROOF_STORAGE_TYPE = "urn:waste:problem:no-proof-storage"

/** The code Storage's body carries for a key it holds already, which it answers 400 rather than 409. */
const KEY_ALREADY_EXISTS = "KeyAlreadyExists"

/** Storage's error body: its own status code (a 400's real one), its code and its sentence. */
type StorageError = { statusCode?: unknown; code?: unknown; message?: unknown }

export const readDriverMe = (client: ApiClient): Promise<DriverMe> => get<DriverMe>(client, "/driver/me")

export const readDriverRoute = (client: ApiClient, id: string): Promise<DriverRouteDetail> => get<DriverRouteDetail>(client, `/driver/routes/${encodeURIComponent(id)}`)

export const sendCommands = (client: ApiClient, commands: readonly PilotCommand[]): Promise<DriverCommandBatchOutcome> => command<DriverCommandBatchOutcome>(client, "/driver/commands", { commands })

export const signProofUpload = (client: ApiClient, request: ProofUploadRequest): Promise<ProofUpload> => command<ProofUpload>(client, "/driver/uploads", request)

/**
 * Puts an object's bytes to the URL Storage signed, through the client's
 * fetch and under its deadline. Answers once Storage holds them, a key it
 * held already included; throws an `ApiProblem` as the client does — the
 * unreachable status where nothing answered, Storage's status and its
 * message otherwise, where Storage's message is its body's (no problem
 * document) and its own status code rides in the body beside a 400.
 */
export async function putObject(client: ApiClient, url: string, { contentType, bytes }: ProofBytes): Promise<void> {
  const doFetch = client.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(url, { method: "PUT", headers: { "content-type": contentType }, body: bytes, ...(client.signal === undefined ? {} : { signal: client.signal }) })
  } catch (cause) {
    throw new ApiProblem(genericProblem(UNREACHABLE_STATUS, `Storage did not answer${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}`))
  }
  if (response.ok) return
  let answer: StorageError | null = null
  try {
    answer = (await response.json()) as StorageError | null
  } catch {
    // No body Storage wrote: a proxy's page, which the status tells.
  }
  if (response.status === 409 || answer?.code === KEY_ALREADY_EXISTS) return
  const status = response.status === 400 && typeof answer?.statusCode === "string" && /^\d{3}$/.test(answer.statusCode) ? Number(answer.statusCode) : response.status
  throw new ApiProblem(genericProblem(status, typeof answer?.message === "string" ? answer.message : undefined))
}

/**
 * Whether a failure is the server out of reach rather than its answer: no
 * answer at all (a request past its deadline included), a timeout, a rate
 * limit, or a 5xx — which is also what the web's own proxy (next.config.mjs)
 * answers while the API is down. The queue keeps everything and tries again;
 * the banner says "Can't reach the server".
 */
export function outOfReach(status: number): boolean {
  return status === UNREACHABLE_STATUS || status === 408 || status === 429 || status >= 500
}
