// Settings' panes, one entry each: where the nav lists it, what heads it,
// the pane ids it took the place of, and the params its address carries. The
// shell (components/settings/SettingsDialog.tsx) renders the nav, the search,
// the deep link and the frame from this table and nothing else, and every
// Settings address in the app is `settingsHref`'s.
//
// Every pane reads the API but Account & appearance (`withoutApi`), whose
// theme is the browser's own: where no API is configured a pane says its
// subject is kept on the API, and draws nothing of it. The browser's twins of
// the API's panes — Asset management, Operations setup, Tickets &
// communication, Commercial defaults, and the fixtures' Notifications,
// Finance, Integrations and Portals forms — are gone, each id absorbed by the
// pane that holds its subject, and so is Company & projects, which read only
// the browser's organisation store.
//
// A pane that took the place of others lists their ids under `absorbs`, each
// with the tab it opens at, or null for none (#548 and #570 of #544), so a
// link or a bookmark made before reads as it did. They live here rather than
// in legacy-ids.ts: the tab a retired id opens is one of its pane's tabs,
// declared beside it and changing with it, and the one resolution below reads
// both.
import { MESSAGE_VARIABLES } from "@waste/domain/messaging/template"

/** The placeholders a message template may name, as a person types them. */
const PLACEHOLDERS = MESSAGE_VARIABLES.map((name) => `{{${name}}}`)

export const SETTINGS_SECTIONS = [
  { id: "personal", label: "Personal" },
  { id: "organization", label: "Organization" },
  { id: "operations", label: "Operations" },
  { id: "administration", label: "Administration" },
  { id: "commercial", label: "Commercial" },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"]

/** The icons the nav draws a pane with, by name: components/settings maps each to its glyph. */
export type SettingsPaneIcon = "bell" | "calendar-blank" | "calendar-check" | "couch" | "credit-card" | "database" | "envelope-simple" | "gear" | "link-simple" | "map-trifold" | "package" | "paint-brush" | "receipt" | "recycle" | "sliders-horizontal" | "squares-four" | "tag" | "ticket" | "user-circle" | "users-three" | "warning"

/** The params of a pane's own address, besides `tab`, which a pane with tabs reads. */
export type SettingsParam = "type" | "record" | "kind"

type PaneSpec = {
  readonly id: string
  readonly section: SettingsSectionId
  /** The nav's name for it. */
  readonly label: string
  readonly icon: SettingsPaneIcon
  /** What its page is titled and described as, and what the search reads besides the label. */
  readonly title: string
  readonly description: string
  /** Words the search finds it by that its title and description do not say. */
  readonly terms?: readonly string[]
  /** Drawn where no API is configured, from the browser's own state: every other pane says its subject is kept on the API. */
  readonly withoutApi?: true
  /** The bar above it names the pane rather than its section, where each of its tabs or records titles itself. */
  readonly headedBy?: "label"
  readonly tabs?: readonly { readonly value: string; readonly label: string }[]
  /** The panes it took the place of, each the tab it opens at, or null for none. */
  readonly absorbs?: Readonly<Record<string, string | null>>
  readonly params?: readonly SettingsParam[]
}

const PANES = [
  {
    id: "account",
    section: "personal",
    label: "Account & appearance",
    icon: "user-circle",
    title: "Account and appearance",
    description: "Your profile, personal defaults, saved views, and visual preferences.",
    terms: ["Appearance", "Theme", "Ash", "Midnight", "Dawn", "Pale", "Custom", "Light", "Dark", "Sidebar color", "Interface color", "Theme code", "Accent"],
    withoutApi: true,
  },
  {
    id: "notifications-on-api",
    section: "personal",
    label: "Notifications",
    icon: "bell",
    title: "Notifications",
    description: "The e-mails you get when something needs you. Nothing is sent until you ask for it.",
    absorbs: { notifications: null },
  },
  {
    id: "access",
    section: "organization",
    label: "Users & roles",
    icon: "users-three",
    title: "Users and roles",
    description: "Manage every system user, role, organization assignment, and project access.",
    headedBy: "label",
    tabs: [
      { value: "users", label: "Users" },
      { value: "roles", label: "Roles" },
      { value: "teams", label: "Teams" },
    ],
    absorbs: { "ticket-teams": "teams" },
  },
  {
    id: "areas",
    section: "operations",
    label: "Areas & Zones",
    icon: "map-trifold",
    title: "Areas & Zones",
    description: "Planning areas, notification zones, and map validation.",
    params: ["record"],
  },
  {
    id: "collection-calendars",
    section: "operations",
    label: "Collection calendars",
    icon: "calendar-blank",
    title: "Collection calendars",
    description: "Validity periods, maintained per project and year; a project's holidays are the days of the company's holiday list it names.",
    params: ["record"],
  },
  {
    id: "holiday-lists",
    section: "operations",
    label: "Holiday lists",
    icon: "calendar-check",
    title: "Holiday lists",
    description: "The company's holiday lists, one per country, and the dated holidays of each; which list every project rests on, and its weekend.",
  },
  {
    id: "operations-bulky-schedules",
    section: "operations",
    label: "Bulky schedules",
    icon: "couch",
    title: "Bulky schedules",
    description: "The days each planning area collects bulky waste on, how many bookings a day takes, and what a booking is charged once collected.",
  },
  {
    id: "master-data",
    section: "operations",
    label: "Master data",
    icon: "database",
    title: "Master data",
    description: "The company's own vocabulary: the waste fractions it collects, the container types it owns, the service frequencies each project offers, and the vehicle types with the container types they service. Products, containers, the fleet and route schemes name these rows.",
    params: ["kind", "record"],
    absorbs: { "asset-management": null, "operations-setup": null },
  },
  {
    id: "tickets",
    section: "operations",
    label: "Tickets",
    icon: "ticket",
    title: "Tickets",
    description: "Everything about the company's tickets in one place: its types, their teams, deadlines and charges, and the counting rules that open tickets.",
    headedBy: "label",
    // In the order a person sets tickets up: what a ticket is, which team works it, by when, at what price, and what opens one.
    tabs: [
      { value: "types", label: "Types" },
      { value: "default-teams", label: "Default teams" },
      { value: "deadlines", label: "Deadlines" },
      { value: "charges", label: "Charges" },
      { value: "counting-rules", label: "Counting rules" },
    ],
    absorbs: { "ticket-types": "types", "ticket-sla": "deadlines", "commercial-ticket-charges": "charges", "counting-rules": "counting-rules", "ticket-comms": "deadlines" },
    // A ticket type's own page, by the API's id, on the Types tab.
    params: ["type"],
  },
  {
    id: "message-templates",
    section: "operations",
    label: "Message templates",
    icon: "envelope-simple",
    title: "Message templates",
    description: `The e-mails and text messages the office sends a customer or one of its contact persons, each for service or for billing. A service message reaches only a customer who allows them; a billing message is sent whatever the customer chose. A text names its values as ${PLACEHOLDERS.join(", ")}.`,
  },
  {
    id: "finance-invoicing",
    section: "administration",
    label: "Finance & invoicing",
    icon: "credit-card",
    title: "Finance & invoicing",
    description: "What the company's invoices print, and when each project's invoices are due, the payment reference they carry and whether its hires and jobs wait for review.",
    absorbs: { finance: null },
  },
  {
    id: "integrations-on-api",
    section: "administration",
    label: "Integrations",
    icon: "link-simple",
    title: "Integrations",
    description: "The services this deployment calls, which way data goes, and their state.",
    absorbs: { integrations: null },
  },
  {
    id: "portals-on-api",
    section: "administration",
    label: "Portals & branding",
    icon: "paint-brush",
    title: "Portals & branding",
    description: "What each project's residents find on its public pages, and which of its drivers use the Driver App.",
    absorbs: { portals: null },
  },
  {
    id: "commercial-products",
    section: "commercial",
    label: "Products",
    icon: "package",
    title: "Products",
    description: "The sellable catalogue of each project, as the API holds it: what an invoice line calls a product, the code a ledger books it under, and its VAT rate. Prices are rows of a price list, added in Price Engine with Add price.",
    absorbs: { pricing: null },
  },
  {
    id: "commercial-price-lists",
    section: "commercial",
    label: "Price lists",
    icon: "receipt",
    title: "Price lists",
    description: "Each project's tariff and the named lists an agreement is priced under. A list's code and currency are set once, since its rows are quoted in them; a list ends on its last day in force. Price Engine's Add price puts a row in one.",
  },
  {
    id: "commercial-visit-rules",
    section: "commercial",
    label: "Recycling-centre charges",
    icon: "recycle",
    title: "Recycling-centre charges",
    description: "How a project's recycling-centre visits are charged: a household's free visits a year and the price of each after them, the fractions brought free, and a business's visit.",
  },
  {
    id: "pickup-exception-charges",
    section: "commercial",
    label: "Exception charges",
    icon: "warning",
    title: "Exception charges",
    description: "What a collection missed for the customer, or collected tagged with a contaminant code, costs them: how many are free over a window, then the products charged by occurrence.",
  },
] as const satisfies readonly PaneSpec[]

export type SettingsPaneId = (typeof PANES)[number]["id"]

export type SettingsPane = PaneSpec & { readonly id: SettingsPaneId }

export const SETTINGS_PANES: readonly SettingsPane[] = PANES

/** The pane Settings opens on when an address names none it can show. */
export const DEFAULT_SETTINGS_PANE: SettingsPaneId = "account"

type PaneOf<Id> = Extract<(typeof PANES)[number], { id: Id }>

/** A pane's tab, by value. */
export type SettingsTabOf<Id extends SettingsPaneId> = Id extends SettingsPaneId ? (PaneOf<Id> extends { tabs: readonly { value: infer Value }[] } ? Value : never) : never

type ParamsOf<Id> = Id extends SettingsPaneId ? (PaneOf<Id> extends { params: readonly (infer Param extends SettingsParam)[] } ? Param : never) | (PaneOf<Id> extends { tabs: readonly unknown[] } ? "tab" : never) : never

/** What an address of the pane may say: its own params, and `from`, where Back to app returns. */
export type SettingsParamsOf<Id extends SettingsPaneId> = { readonly [Param in ParamsOf<Id>]?: (Param extends "tab" ? SettingsTabOf<Id> : string) | null } & { readonly from?: string }

/** A pane's params as an address holds them: the ones it declares, each a value. */
export type SettingsParams = Partial<Readonly<Record<SettingsParam | "tab", string>>>

/** What Settings shows: a pane, and the params of its own it was asked with. */
export type SettingsAddress = { readonly pane: SettingsPaneId; readonly params: SettingsParams }

export function settingsPaneOf(id: string | undefined): SettingsPane | undefined {
  return SETTINGS_PANES.find((pane) => pane.id === id)
}

export function settingsPane(id: SettingsPaneId): SettingsPane {
  const pane = settingsPaneOf(id)
  if (pane === undefined) throw new Error(`No Settings pane ${id}`)
  return pane
}

/** A pane's tabs. */
export function settingsTabsOf(paneId: SettingsPaneId): NonNullable<SettingsPane["tabs"]> {
  return settingsPane(paneId).tabs ?? []
}

/** The params `given` holds that the pane reads: its own, and one of its tabs. */
function paramsRead(pane: SettingsPane, given: Readonly<Record<string, string | null | undefined>>): SettingsParams {
  const read: Partial<Record<SettingsParam | "tab", string>> = {}
  for (const param of pane.params ?? []) {
    const value = given[param]
    if (typeof value === "string" && value !== "") read[param] = value
  }
  const tab = given.tab
  if (typeof tab === "string" && settingsTabsOf(pane.id).some((offered) => offered.value === tab)) read.tab = tab
  return read
}

/**
 * The pane an address shows, and the params it reads: a retired pane's id
 * opens the pane that absorbed it at its tab; an id no pane answers to opens
 * the default pane.
 */
export function settingsAddressShown(requested: string | undefined, given: Readonly<Record<string, string | null | undefined>>): SettingsAddress {
  const absorbing = requested === undefined ? undefined : SETTINGS_PANES.find((pane) => pane.absorbs !== undefined && Object.hasOwn(pane.absorbs, requested))
  const pane = absorbing ?? settingsPaneOf(requested)
  if (pane === undefined) return { pane: DEFAULT_SETTINGS_PANE, params: {} }
  const params = absorbing === undefined ? given : { ...given, tab: absorbing.absorbs?.[requested ?? ""] }
  return { pane: pane.id, params: paramsRead(pane, params) }
}

/** Whether a pane draws where no API is configured: its subject is the browser's own, not the API's. */
export function settingsPaneDrawnWithoutApi(pane: SettingsPane): boolean {
  return pane.withoutApi === true
}

/** The bar above a pane: its section, or the pane itself where its tabs or records title themselves. */
export function settingsPaneHeading(pane: SettingsPane): string {
  return pane.headedBy === "label" ? pane.label : (SETTINGS_SECTIONS.find((section) => section.id === pane.section)?.label ?? pane.label)
}

/**
 * The nav: each section with its panes, those the search finds where a
 * person typed one — by label, title, description, terms, and `moreTerms`,
 * the words a pane's own content says.
 */
export function settingsNav(search: string, moreTerms: (paneId: SettingsPaneId) => readonly string[] = () => []) {
  const needle = search.trim().toLowerCase()
  const found = (pane: SettingsPane) => needle === "" || [pane.label, pane.title, pane.description, ...(pane.terms ?? []), ...moreTerms(pane.id)].join(" ").toLowerCase().includes(needle)
  return SETTINGS_SECTIONS.map((section) => ({
    ...section,
    panes: SETTINGS_PANES.filter((pane) => pane.section === section.id && found(pane)),
  })).filter((section) => needle === "" || section.panes.length > 0)
}

/** A Settings address: the pane, the params of its own it is given (others are left out), and `from`, where Back to app returns, unless that is the start. */
export function settingsHref<Id extends SettingsPaneId>(paneId: Id, params?: SettingsParamsOf<Id>): string {
  return hrefOf(paneId, params ?? {})
}

/** The address of what Settings shows, `from` where Back to app returns where one is given. */
export function settingsAddressHref(address: SettingsAddress, from?: string): string {
  return hrefOf(address.pane, { ...address.params, from })
}

function hrefOf(paneId: SettingsPaneId, given: Readonly<Record<string, string | null | undefined>>): string {
  const pane = settingsPane(paneId)
  const query = new URLSearchParams({ pane: paneId })
  for (const param of [...(pane.tabs === undefined ? [] : ["tab" as const]), ...(pane.params ?? [])]) {
    const value = given[param]
    if (typeof value === "string" && value !== "") query.set(param, value)
  }
  const from = given.from
  if (typeof from === "string" && from !== "/") query.set("from", from)
  return `/settings?${query.toString()}`
}

/**
 * The project a per-project pane shows: the one picked where the pane lists
 * it, else its first by name, so every such pane — and the tabs of Settings ›
 * Tickets, which share their pick — opens on the same one. `serverIdOf` names
 * a listed project by the API's id.
 */
export function projectShown<P extends { name: string }>(projects: readonly P[], picked: string | null, serverIdOf: (project: P) => string | undefined): P | null {
  return projects.find((project) => picked !== null && serverIdOf(project) === picked) ?? [...projects].sort((one, other) => one.name.localeCompare(other.name))[0] ?? null
}
