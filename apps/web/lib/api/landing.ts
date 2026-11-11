// Where a person goes on the Pilot (Issue #150), as rules and nothing else:
// the sign-in gate (components/auth/sign-in-gate.tsx) and /login
// (components/auth/login-view.tsx) ask these, so what they do is tested here
// and not in a browser.
//
//   the landing — `/me` decides it (`Me.driver`, `Me.serviceProvider`): a
//                 driver lands on the driver's app, a Service Provider's
//                 account on its workspace (#291 slice 23), everyone else on
//                 the office's pages; never a probe of the driver door.
//                 A provider's driver is a driver first: the phone is where
//                 the work is. A Site attendant (#393) lands on the
//                 recycling centre's check-in, after those two: the seeded
//                 role's key. The office lands on operations where its role
//                 views anything there, else on the sidebar's first page it
//                 views anything on that is not the Dashboard — a page of
//                 reports is no place to start work, so it is the landing
//                 only of a role that views nothing else — and on
//                 operations, which says it may view nothing, where it views
//                 nothing at all. `/driver` is
//                 the Driver App (#145, components/waste/driver/),
//                 `/service-provider-workspace` the provider's restricted
//                 shell, `/check-in` the attendant's phone-first page
//                 (components/waste/check-in/);
//   the gate    — with the adapter on, every page but /login and the public
//                 pages under /p/ (ADR-0010: a published project's, for
//                 anyone, no account) needs a session:
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
import type { ModuleKey } from "@waste/domain/access/modules"
import type { SystemRoleKey } from "@waste/domain/access/system-roles"

import { DASHBOARD, navItems, type NavItemId } from "../data/sidebar"
import { PERFORMANCE_MODULE } from "../insight/dashboard"
import { pageModuleIds } from "../modules/manifest"
import { PROVIDER_WORKSPACE_PATH } from "../modules/provider-pages"
import { viewedModules, type Grants } from "@/lib/modules/grants"
import { moduleKeyOf } from "@/lib/modules/keys"
import type { SessionEnding } from "./session"

/** The one page the gate never stands in front of. */
export const SIGN_IN_PATH = "/login"

/** Where a published project's public pages live, `/p/<slug>/…` (ADR-0010): read by anyone, so the gate never stands in front of them. */
export const PUBLIC_PATH_PREFIX = "/p/"

/** Whether a path is one of the public pages, which need no session. */
export const isPublicPath = (pathname: string): boolean => pathname.startsWith(PUBLIC_PATH_PREFIX)

/** The seeded role whose accounts land on the check-in. */
export const SITE_ATTENDANT_ROLE: SystemRoleKey = "site-attendant"

export const OFFICE_LANDING = "/operate"

/** What the landing reads of `/me`: the driver, the provider, and the role's key and grants, each read defensively. */
export type LandingFacts = Pick<Me, "driver" | "serviceProvider"> & { role?: (Pick<Me["role"], "key"> & { grants?: Grants }) | null }

/** Whether a role views anything on an office page: the Dashboard's Performance, or one of the modules a workspace's page shows. */
function viewsPage(id: NavItemId, viewed: ReadonlySet<ModuleKey>): boolean {
  if (id === DASHBOARD.id) return viewed.has(PERFORMANCE_MODULE)
  return pageModuleIds(id).some((moduleId) => viewed.has(moduleKeyOf(id, moduleId)))
}

/**
 * Where a signed-in person lands when they were going nowhere in particular:
 * a driver on the Driver App, then a Service Provider's account on its
 * workspace, then a Site attendant on the check-in, then the office on
 * operations where its role views anything there, else on the sidebar's
 * first page it views anything on, the Dashboard last of them, else on
 * operations, whose page says it may view nothing. A body with no `driver`, no `serviceProvider` or no `role`
 * at all — an API from before it — is no driver's, no provider's and no
 * attendant's, and one with no grants lands the office on operations: `/me`
 * is read as a type and not checked, so the facts are read defensively.
 */
export function landingOf(me: LandingFacts): string {
  if (me.driver?.id !== undefined) return "/driver"
  if (me.serviceProvider?.id !== undefined) return PROVIDER_WORKSPACE_PATH
  if (me.role?.key === SITE_ATTENDANT_ROLE) return "/check-in"
  const grants = me.role?.grants
  if (grants === undefined) return OFFICE_LANDING
  const viewed = viewedModules(grants)
  if (viewsPage("operate", viewed)) return OFFICE_LANDING
  const pages = navItems.filter((item) => viewsPage(item.id, viewed))
  return (pages.find((item) => item.id !== DASHBOARD.id) ?? pages[0])?.href ?? OFFICE_LANDING
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

export function afterSignIn(me: LandingFacts, next: string | null | undefined): string {
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
  if (!configured || pathname === SIGN_IN_PATH || isPublicPath(pathname)) return "show"
  if (!hydrated) return "wait"
  return signedIn ? "show" : "sign-in"
}

/**
 * Whether a visitor still carries where they were going: yes while they
 * never signed in here, or their session ran out with nobody to refresh it;
 * no after a sign-out or a refused account, so the next person to sign in
 * lands by their own `/me`. /login drops a `next` from its address when a
 * session ends on it.
 */
export function carriesNext(ended: SessionEnding | null): boolean {
  return ended === null || ended.reason === "expired"
}

/** The sign-in page for a visitor at `here` (a path and query): `/login?next=` while they carry it, else bare `/login`. */
export function signInTarget(ended: SessionEnding | null, here: string): string {
  const next = carriesNext(ended) ? returnPath(here) : null
  return next === null ? SIGN_IN_PATH : `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`
}
