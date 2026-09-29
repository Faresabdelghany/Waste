// Where a person goes on the Pilot (Issue #150), as rules and nothing else:
// the sign-in gate (components/auth/sign-in-gate.tsx) and /login
// (components/auth/login-view.tsx) ask these, so what they do is tested here
// and not in a browser.
//
//   the landing — `/me` decides it (`Me.driver`): a driver lands on the
//                 driver's app, everyone else on operations; never a grant,
//                 never a probe of the driver door;
//   the gate    — with the adapter on, every page but /login needs a session:
//                 nothing renders until the browser's session is read, and a
//                 visitor without one is sent to /login, carrying where they
//                 were going as `?next=`; with the adapter off (fixture mode,
//                 local development, e2e) every page renders as before;
//   the return  — after sign-in the person goes back to `next` when it is a
//                 page of this application, else lands by `/me`. A session
//                 that ended by a sign-out or by the account's refusal
//                 carries no `next`: whoever signs in next lands by their own
//                 `/me`, not on the page the last person left.
import type { Me } from "@waste/contracts/me"

import type { SessionEnding } from "./session"

/** The one page the gate never stands in front of. */
export const SIGN_IN_PATH = "/login"

/** Where a signed-in person lands when they were going nowhere in particular. */
export function landingOf(me: Pick<Me, "driver">): "/driver" | "/operate" {
  return me.driver !== null ? "/driver" : "/operate"
}

// Only to parse a relative `next` against: a value that resolves anywhere
// else was naming another origin, however it was spelled.
const OWN_ORIGIN = "https://waste.invalid"

/**
 * The page `next` names when it is one of this application's own — its path,
 * query and fragment, as the URL parser reads them — else null: another
 * origin in any spelling (`//host`, `/\host`, a scheme), a relative path,
 * /login itself, or the root, which only ever leads to the landing.
 */
export function returnPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null
  let url: URL
  try {
    url = new URL(next, OWN_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== OWN_ORIGIN) return null
  // What is returned is the parsed path, so it is the parsed path that must
  // not name another origin: the parser removes dot segments and turns `\`
  // into `/`, and `/.//host` comes out as the protocol-relative `//host`.
  if (url.pathname.startsWith("//")) return null
  // Next redirects a trailing slash away, so `/login/` is /login too.
  const page = url.pathname.replace(/\/+$/, "")
  if (page === "" || page === SIGN_IN_PATH) return null
  return `${url.pathname}${url.search}${url.hash}`
}

/** Where sign-in sends the person: back to `next` when it is one of ours, else their landing. */
export function afterSignIn(me: Pick<Me, "driver">, next: string | null | undefined): string {
  return returnPath(next) ?? landingOf(me)
}

export type GateState = {
  /** Whether the adapter is on (`API_CONFIG`); off, the gate lets every page through. */
  configured: boolean
  /** Whether the browser's stored session has been read. */
  hydrated: boolean
  signedIn: boolean
}

/** What the gate does on a page: render it, render nothing until the stored session is read, or send the visitor to sign in. */
export function gateOf({ configured, hydrated, signedIn }: GateState, pathname: string): "show" | "wait" | "sign-in" {
  if (!configured || pathname === SIGN_IN_PATH) return "show"
  if (!hydrated) return "wait"
  return signedIn ? "show" : "sign-in"
}

/**
 * The sign-in page for a visitor at `here` (a path and query): `/login?next=`
 * while they were on their way somewhere — never signed in here, or their
 * session ran out with nobody to refresh it — and bare `/login` after a
 * sign-out or a refused account.
 */
export function signInTarget(ended: SessionEnding | null, here: string): string {
  const next = ended === null || ended.reason === "expired" ? returnPath(here) : null
  return next === null ? SIGN_IN_PATH : `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`
}
