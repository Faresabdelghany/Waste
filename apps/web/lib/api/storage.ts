// An object's bytes put to the URL Storage signed for it (O1 of #290): the
// Driver App's photos and signatures, a field inspection's photos. The API
// names the key and signs the URL; the bytes go to Storage, another origin
// than the API's, with no token of the API's, the URL being the permission.
import { UNREACHABLE_STATUS, type ApiClient } from "./client"
import { ApiProblem, genericProblem } from "./problem"

/** The bytes put, and the type Storage keeps them under. */
export type ObjectBytes = { contentType: string; bytes: ArrayBuffer }

/** The code Storage's body carries for a key it holds already, which it answers 400 rather than 409. */
const KEY_ALREADY_EXISTS = "KeyAlreadyExists"

/** Storage's error body: its own status code (a 400's real one), its code and its sentence. */
type StorageError = { statusCode?: unknown; code?: unknown; message?: unknown }

/**
 * Puts an object's bytes to the URL Storage signed, through the client's
 * fetch and under its deadline. Answers once Storage holds them, a key it
 * held already included; throws an `ApiProblem` as the client does — the
 * unreachable status where nothing answered, Storage's status and its
 * message otherwise, where Storage's message is its body's (no problem
 * document) and its own status code rides in the body beside a 400.
 */
export async function putObject(client: ApiClient, url: string, { contentType, bytes }: ObjectBytes): Promise<void> {
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
