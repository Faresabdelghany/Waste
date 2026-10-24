// Proof objects (O1 of #290): where a photo's or a signature's bytes go and
// how they are read back, signed by the API and never carried by it. The
// bytes live in the private `proofs` bucket under the key the command names
// (`objectKeyOf`, @waste/domain/execution/commands), and the API holds
// Storage's service-role key (`@waste/db/storage`):
//
//   POST /driver/uploads           the driver door: the upload URL of one of
//                                  the device's own commands' objects, on a
//                                  route assigned to the driver (the door's
//                                  fence, `findAssignedRoute`) and active, as
//                                  the door applies the command only on one;
//                                  `uploaded`
//                                  where the bucket holds the key already, a
//                                  retry after an upload whose answer was
//                                  lost. The device puts the bytes, then
//                                  sends `add-photo` / `add-signature`.
//   GET /pickups/:id/proof-objects the office, or a Service Provider's
//                                  account on a route it runs: read URLs for
//                                  the stop's proofs that name an object,
//                                  behind the grant and the reach the stop's
//                                  own read has (`GET /pickups/:id`); a key
//                                  the bucket does not hold is a null URL.
//
// Both call Storage, and no transaction is held across a call to another
// service (#124 §4): their guard is `identify`, and each handler reads the
// fence in one short transaction of its own before it asks Storage. A
// deployment without the key has no Storage: both answer 503 in one sentence,
// typed `NO_PROOF_STORAGE` so a device tells it from an outage, and so does
// one whose Storage refuses the call (no bucket, a key it does not take);
// Storage's silence is a 502 the device asks again past.
import { NO_PROOF_STORAGE } from "@waste/contracts/problem"
import { ProofObjectLinks, ProofUpload, ProofUploadRequest } from "@waste/contracts/proof-objects"
import type { Database } from "@waste/db/client"
import { pickup, proofOfService } from "@waste/db/schema/execution"
import { StorageRefused, StorageSilent, type ProofStorage } from "@waste/db/storage"
import { withCompany } from "@waste/db/tenant"
import { objectKeyOf } from "@waste/domain/execution/commands"
import { notActive } from "@waste/domain/execution/transitions"
import { and, asc, eq, isNotNull } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { resolveDriver } from "../auth/driver"
import { BEARER_SECURITY, type IdentifiedEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { describeProblem, loggable, problem, validate } from "../problem"
import { findAssignedRoute, labelOf, noSuchAssignedRoute, noSuchPickup, pickupReach } from "./execution-shapes"
import { describeJson, IdParam } from "./shared"

/** The grant a stop's proofs are read under: the stop's own read's. */
const PICKUPS = "route-studio.pickups"

/** How long a read URL lasts: long enough to open a stop's details and look, short enough that a URL passed on lapses. */
export const READ_URL_TTL_SECONDS = 10 * 60

/** What a deployment without Storage's key is told. */
export const NO_PROOF_STORAGE_DETAIL = "Photos and signatures are not stored on this deployment: it holds no Storage key"

/** What Storage's silence is told: nothing was signed, and the request may be asked again. */
export const STORAGE_SILENT = "Storage did not answer; nothing was signed, and the request may be asked again"

/** What Storage's refusal is told: the deployment's bucket or key is not as its migration and settings make them, which asking again does not change. */
export const STORAGE_REFUSED = "Storage refused the request: this deployment's proofs bucket or its key is not in order"

export type ProofObjectOptions = {
  /** The request pool: each handler's one short transaction runs on it. */
  pool: Database
  /** The proofs' Storage, or null on a deployment without its key. */
  storage: ProofStorage | null
  /** The app's clock: when a read URL lapses. */
  now: () => Date
  /** Where the cause of Storage's silence goes. */
  log: (error: unknown) => void
}

export function proofObjectRoutes(guard: MiddlewareHandler<IdentifiedEnv>, { pool, storage, now, log }: ProofObjectOptions) {
  /** Storage, or the deployment's 503. */
  const required = (): ProofStorage => {
    if (storage === null) throw problem(503, { kind: NO_PROOF_STORAGE, detail: NO_PROOF_STORAGE_DETAIL })
    return storage
  }
  /** A call to Storage: its silence a 502, its refusal the deployment's 503, and the cause of either in the log. */
  const asking = async <T>(ask: () => Promise<T>): Promise<T> => {
    try {
      return await ask()
    } catch (error) {
      if (error instanceof StorageRefused) {
        log(loggable(error))
        throw problem(503, { kind: NO_PROOF_STORAGE, detail: STORAGE_REFUSED })
      }
      if (!(error instanceof StorageSilent)) throw error
      log(loggable(error))
      throw problem(502, { detail: STORAGE_SILENT })
    }
  }

  return new Hono<IdentifiedEnv>()
    .post(
      "/driver/uploads",
      describeRoute({
        operationId: "signProofUpload",
        summary: "Where the device puts the bytes of one of its commands' photos or signatures",
        description:
          "The driver door (O1 of #290). The object of the command `commandId` on the route `routeId`, which must be assigned to the driver and active — the door applies the command on no other — lives in the private `proofs` bucket under `<companyId>/<routeId>/<commandId>.<extension>`; the answer is that key and a signed URL to `PUT` the bytes to, straight to Storage, until `expiresAt` (`state: \"upload\"`), or that the bucket holds the key already (`state: \"uploaded\"`), a retry after an upload whose answer was lost. The device then sends the `add-photo` or `add-signature` command naming the key, which the door holds to the same three ids. Nothing is written here, and no byte passes through the API.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The key, and where to put the bytes or that they are there.", ProofUpload),
          400: describeProblem("The body is not a route id, a command id and one of the bucket's formats."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or no active driver profile is bound to this login."),
          404: describeProblem("The route is not assigned to this driver, or not there."),
          409: describeProblem("The route is not active: the door would reject the command the object is for."),
          502: describeProblem(STORAGE_SILENT),
          503: describeProblem(`${NO_PROOF_STORAGE_DETAIL}; or ${STORAGE_REFUSED}`),
        },
      }),
      guard,
      validate("json", ProofUploadRequest),
      async (c) => {
        const bucket = required()
        const { routeId, commandId, extension } = c.req.valid("json")
        const principal = c.get("principal")
        await withCompany(pool.db, principal.companyId, async (tx) => {
          const profile = await resolveDriver(tx, principal)
          const assigned = await findAssignedRoute(tx, principal, profile, routeId)
          if (assigned === undefined) throw noSuchAssignedRoute(routeId)
          // An object no command can land for is one nothing ever names, which the purge would never find.
          if (assigned.status !== "active") throw problem(409, { detail: notActive(labelOf(assigned)) })
        })
        const objectKey = objectKeyOf({ companyId: principal.companyId, routeId, commandId }, extension)
        const signed = await asking(() => bucket.signUpload(objectKey))
        const answer: ProofUpload = signed.kind === "exists" ? { state: "uploaded", objectKey } : { state: "upload", objectKey, uploadUrl: signed.url, expiresAt: signed.expiresAt.toISOString() }
        return c.json(answer)
      },
    )
    .get(
      "/pickups/:id/proof-objects",
      describeRoute({
        operationId: "getPickupProofObjects",
        summary: "Read URLs for a stop's photos and signatures",
        description: `A read URL for each of the stop's Proofs of Service that names an object, in recording order, lasting ${READ_URL_TTL_SECONDS / 60} minutes; a null URL where the private \`proofs\` bucket holds no such object — never uploaded, or removed after its days. The stop is read under the grant and the reach of \`GET /pickups/:id\`: a pickup of the caller's projects, or of a route a Service Provider's account runs. No byte passes through the API.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The stop's objects and their read URLs.", ProofObjectLinks),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${PICKUPS}\`.`),
          404: describeProblem("No such pickup in the projects this account works in, or, for a Service Provider's account, on no route its provider runs."),
          502: describeProblem(STORAGE_SILENT),
          503: describeProblem(`${NO_PROOF_STORAGE_DETAIL}; or ${STORAGE_REFUSED}`),
        },
      }),
      guard,
      requireGrant(PICKUPS, "view"),
      validate("param", IdParam),
      async (c) => {
        const bucket = required()
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        const objects = await withCompany(pool.db, principal.companyId, async (tx) => {
          const [stop] = await tx.select({ id: pickup.id }).from(pickup).where(and(pickupReach(tx, principal), eq(pickup.id, id))).limit(1)
          if (stop === undefined) throw noSuchPickup(id)
          return await tx
            .select({ proofId: proofOfService.id, objectKey: proofOfService.objectKey })
            .from(proofOfService)
            .where(and(eq(proofOfService.companyId, principal.companyId), eq(proofOfService.pickupId, id), isNotNull(proofOfService.objectKey)))
            .orderBy(asc(proofOfService.id))
        })
        const keyed = objects.flatMap(({ proofId, objectKey }) => (objectKey === null ? [] : [{ proofId, objectKey }]))
        const expiresAt = new Date(now().getTime() + READ_URL_TTL_SECONDS * 1000).toISOString()
        const urls = await asking(() => bucket.signReads([...new Set(keyed.map((object) => object.objectKey))], READ_URL_TTL_SECONDS))
        const answer: ProofObjectLinks = { items: keyed.map(({ proofId, objectKey }) => ({ proofId, objectKey, url: urls.get(objectKey) ?? null, expiresAt })) }
        return c.json(answer)
      },
    )
}
