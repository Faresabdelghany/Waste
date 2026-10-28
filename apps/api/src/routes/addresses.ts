// The address lookup (#291 C13, #290 O29): the office's search of the
// national address register, and the register read for a Property's write.
// `GET /addresses?q=` answers the addresses a typed text begins and
// `GET /addresses/:id` one address whole — its parts, the BFE number of the
// property it lies on, its access point — for the web's address picker, under
// a grant to create or to edit properties, since a picker serves those two
// forms alone.
//
// No transaction is held across the register's call (#124 §4), as the
// routing preview holds none across the provider's: the two reads' guard is
// `identify`, and neither reads a row. A Property's create and patch hold
// their transaction for the rows, so their address is read before it opens:
// `addressLookup` stands before the property route's guard and, where the
// body names an `addressId`, identifies the caller, asks the grant, reads the
// address from the register and leaves it for the handler (`foundAddress`),
// which judges it in the request's transaction — an id the register does not
// hold is a 400 on `addressId` there, in the order a body's field is judged.
// A body that names none passes straight on: a typed address and a point
// placed by hand ask nothing of the register. A register that does not
// answer is a 502, as the routing provider's silence is, saying what the
// office can do without it; its reason is logged, never answered.
import { Address, AddressId, AddressSearch, AddressSearchQuery, ADDRESS_ATTRIBUTION } from "@waste/contracts/addresses"
import type { ModuleKey } from "@waste/domain/access/modules"
import { Hono, type Context, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import * as z from "zod"

import { RegisterUnavailable, REGISTER_UNAVAILABLE, type AddressRegister } from "../address-register/register"
import { BEARER_SECURITY, type IdentifiedEnv } from "../auth/principal"
import { allows } from "../auth/require"
import { describeProblem, loggable, problem, validate } from "../problem"
import { describeJson } from "./shared"

const MODULE: ModuleKey = "customers.properties"

/** The 403 unless the caller may create or edit properties: the two forms the picker serves. */
function requireLookupGrant(c: Context<IdentifiedEnv>): void {
  const { grants } = c.get("principal")
  if (!allows(grants, MODULE, "create") && !allows(grants, MODULE, "edit")) {
    throw problem(403, { detail: `This account's role does not allow create or edit on ${MODULE}` })
  }
}

const lookupGrant: MiddlewareHandler<IdentifiedEnv> = async (c, next) => {
  requireLookupGrant(c)
  await next()
}

export type AddressLookupOptions = {
  register: AddressRegister
  log: (line: unknown) => void
}

/** One call to the register, its silence a 502 with what the office can do, its reason logged. */
async function asking<Answer>(log: AddressLookupOptions["log"], call: () => Promise<Answer>): Promise<Answer> {
  try {
    return await call()
  } catch (error) {
    if (!(error instanceof RegisterUnavailable)) throw error
    log(loggable(error))
    throw problem(502, { detail: REGISTER_UNAVAILABLE })
  }
}

const AddressIdParam = z.object({ id: AddressId })

export function addressRoutes(guard: MiddlewareHandler<IdentifiedEnv>, { register, log }: AddressLookupOptions) {
  const forbidden = describeProblem(`No active account here, or the caller's role allows neither \`create\` nor \`edit\` on \`${MODULE}\`.`)
  const silent = describeProblem("The address register did not answer. Try again, or type the address and place the point by hand.")
  return new Hono<IdentifiedEnv>()
    .get(
      "/addresses",
      describeRoute({
        operationId: "searchAddresses",
        summary: "Search the address register",
        description:
          "The addresses in the national address register (DAR) whose designation the typed text begins, word by word, ten at most, by the register's id and designation, for the property forms' address picker. Nothing is stored. `attribution` is what a surface that shows them owes the register. Read one address whole through `GET /addresses/{id}`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The addresses found, none when nothing matches.", AddressSearch),
          400: describeProblem("`q` is shorter than two characters or longer than 200."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: forbidden,
          502: silent,
        },
      }),
      guard,
      lookupGrant,
      validate("query", AddressSearchQuery),
      async (c) => {
        const { q } = c.req.valid("query")
        const items = await asking(log, () => register.search(q))
        return c.json({ items, attribution: ADDRESS_ATTRIBUTION } satisfies AddressSearch)
      },
    )
    .get(
      "/addresses/:id",
      describeRoute({
        operationId: "getAddress",
        summary: "One address of the register, whole",
        description:
          "One address of the national address register by the register's id: its designation, its parts, the BFE number of the property it lies on and its access point, either of the last two null where the register holds none. A property created or changed with this `addressId` stores the same.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The address.", Address),
          400: describeProblem("The path does not hold a UUID."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: forbidden,
          404: describeProblem("The register holds no address by that id."),
          502: silent,
        },
      }),
      guard,
      lookupGrant,
      validate("param", AddressIdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const found = await asking(log, () => register.find(id))
        if (found === null) throw problem(404, { detail: `No address ${id} in the address register` })
        return c.json(found satisfies Address)
      },
    )
}

/** What the register said of a write's `addressId`: the address, null for an id it does not hold, undefined where the body named none. */
const found = new WeakMap<Request, Address | null>()

/** The address `addressLookup` read for this request's body; undefined where the body named no `addressId`. */
export const foundAddress = (c: Context): Address | null | undefined => found.get(c.req.raw)

/** The `addressId` a body names, read before the body's validator; undefined for any body that names none or names it in a shape the validator will refuse. */
async function namedAddressId(c: Context): Promise<string | undefined> {
  if (!(c.req.header("content-type") ?? "").includes("application/json")) return undefined
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return undefined
  }
  const named = typeof body === "object" && body !== null && "addressId" in body ? (body as { addressId: unknown }).addressId : undefined
  const parsed = AddressId.safeParse(named)
  return parsed.success ? parsed.data : undefined
}

/**
 * Before a property write's guard: where the body names an `addressId`, the
 * caller identified and granted (`identify`'s checks, its transaction ended
 * before the call), the address read from the register for the handler, and
 * then the route's own guard; any other body passes straight on.
 */
export function addressLookup(identified: MiddlewareHandler<IdentifiedEnv>, { register, log }: AddressLookupOptions): MiddlewareHandler {
  return async (c, next) => {
    const id = await namedAddressId(c)
    if (id === undefined) return await next()
    await identified(c as unknown as Context<IdentifiedEnv>, async () => {
      requireLookupGrant(c as unknown as Context<IdentifiedEnv>)
      found.set(c.req.raw, await asking(log, () => register.find(id)))
      await next()
    })
  }
}
