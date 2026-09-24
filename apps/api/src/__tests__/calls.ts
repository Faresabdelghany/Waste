// Calling the API as one of a tenant's accounts. Every route test does the
// same three things — sign a token for an account of a seeded company, put it
// in an Authorization header, and read the response — so they are here once
// rather than in each file. The token is signed per call by the test file's
// own key pair (tokens.ts), which is what the API verifies against.
//
// A call takes the method and the body the way a client would; nothing here
// knows what a route answers, so a test reads the response itself (and reads
// an error body through read-problem.ts).
import type { Hono } from "hono"

import { signToken, type SigningKeys } from "./tokens"
import type { Account } from "./tenant"

/** What a test needs of the app: Hono's own `request`, so `createApp(...)` or a bare sub-app both fit. */
export type Callable = Pick<Hono, "request">

export type CallOptions = {
  method?: string
  /** Sent as JSON; absent for a GET. */
  body?: unknown
}

/** One account's way of calling the API. */
export type Call = (path: string, options?: CallOptions) => Promise<Response>

/**
 * Calls as this account, in this company: the account's login is the token's
 * `sub` and the company is the hook's claim, so a test can also call as an
 * account with a claim naming a company it is not in.
 */
export function callingAs(app: Callable, keys: SigningKeys, account: Account, companyId: string): Call {
  if (account.authUserId === null) throw new Error(`${account.email} has never signed in: no token to sign`)
  const sub = account.authUserId
  return async (path, { method = "GET", body }: CallOptions = {}) => {
    const token = await signToken(keys, { sub, companyId, email: account.email })
    return app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}
