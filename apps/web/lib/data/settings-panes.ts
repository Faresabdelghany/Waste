// Settings' panes, one entry each: where the nav lists it, what heads it,
// which mode offers it and where a link to it lands in the other, the pane
// ids it took the place of, and the params its address carries. The shell
// (components/settings/SettingsDialog.tsx) renders the nav, the search, the
// deep link and the frame from this table and nothing else, and every
// Settings address in the app is `settingsHref`'s.
//
// A pane is offered with the adapter configured (`api`), without it
// (`fixture`), or in both. A pane one mode lacks names the pane a link to it
// opens there (`instead`), or opens the default pane: the browser's panes
// whose subject the API holds open the API's pane on the Pilot (#176, #181,
// #291 C4, #487, O16 of #290), and the API's panes the browser's in fixture
// mode. Company & projects reads only the browser's organisation store, which
// has no API, so it is fixture mode's alone.
//
// A pane that took the place of others lists their ids under `absorbs`, each
// with the tab it opens at (#548 and #570 of #544), so a link or a bookmark
// made before reads as it did. They live here rather than in legacy-ids.ts:
// the tab a retired id opens is one of its pane's tabs, declared beside it
// and changing with it, and the one resolution below reads both.
import { PLACEHOLDERS } from "./message-templates"

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

type SettingsMode = "fixture" | "api"

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
  readonly offered: SettingsMode | "both"
  /** Where a link to it lands in the mode that does not offer it; none, the default pane. */
  readonly instead?: { readonly pane: string; readonly tab?: string }
  /** The bar above it names the pane rather than its section, where each of its tabs or records titles itself. */
  readonly headedBy?: "label"
  readonly tabs?: readonly { readonly value: string; readonly label: string; readonly offered?: SettingsMode }[]
  /** The panes it took the place of, each the tab it opens at. */
  readonly absorbs?: Readonly<Record<string, string>>
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
    offered: "both",
  },
  {
    id: "notifications",
    section: "personal",
    label: "Notifications",
    icon: "bell",
    title: "Notifications",
    description: "Personal delivery preferences within the recipient scope configured by administrators.",
    offered: "fixture",
    instead: { pane: "notifications-on-api" },
  },
  {
    id: "notifications-on-api",
    section: "personal",
    label: "Notifications",
    icon: "bell",
    title: "Notifications",
    description: "The e-mails you get when something needs you. Nothing is sent until you ask for it.",
    offered: "api",
    instead: { pane: "notifications" },
  },
  {
    id: "company",
    section: "organization",
    label: "Company & projects",
    icon: "squares-four",
    title: "Companies",
    description: "Manage company identities, administrators, projects, and tenant-level operational data.",
    terms: ["Create company", "Add company", "Add project", "Company administrator", "First project", "Tenant", "Legal name", "Registration number", "Language", "Currency", "Timezone"],
    offered: "fixture",
    headedBy: "label",
  },
  {
    id: "access",
    section: "organization",
    label: "Users & roles",
    icon: "users-three",
    title: "Users and roles",
    description: "Manage every system user, role, organization assignment, and project access.",
    offered: "both",
    headedBy: "label",
    tabs: [
      { value: "users", label: "Users" },
      { value: "roles", label: "Roles" },
      { value: "teams", label: "Teams", offered: "api" },
    ],
    absorbs: { "ticket-teams": "teams" },
  },
  {
    id: "asset-management",
    section: "operations",
    label: "Asset management",
    icon: "gear",
    title: "Asset management",
    description: "Configure the company asset libraries.",
    terms: ["Containers", "Container Types", "Waste Fractions", "Spare Parts", "Part Types", "Property equipment", "Key Types", "Locksmith"],
    offered: "fixture",
    instead: { pane: "master-data" },
    headedBy: "label",
  },
  {
    id: "areas",
    section: "operations",
    label: "Areas & Zones",
    icon: "map-trifold",
    title: "Areas & Zones",
    description: "Planning areas, notification zones, and map validation.",
    offered: "both",
    params: ["record"],
  },
  {
    id: "collection-calendars",
    section: "operations",
    label: "Collection calendars",
    icon: "calendar-blank",
    title: "Collection calendars",
    description: "Validity periods, maintained per project and year; a project's holidays are the days of the company's holiday list it names.",
    offered: "both",
    params: ["record"],
  },
  {
    id: "holiday-lists",
    section: "operations",
    label: "Holiday lists",
    icon: "calendar-check",
    title: "Holiday lists",
    description: "The company's holiday lists, one per country, and the dated holidays of each; which list every project rests on, and its weekend.",
    offered: "both",
  },
  {
    id: "operations-bulky-schedules",
    section: "operations",
    label: "Bulky schedules",
    icon: "couch",
    title: "Bulky schedules",
    description: "The days each planning area collects bulky waste on, how many bookings a day takes, and what a booking is charged once collected.",
    offered: "api",
  },
  {
    id: "master-data",
    section: "operations",
    label: "Master data",
    icon: "database",
    title: "Master data",
    description: "The company's own vocabulary: the waste fractions it collects, the container types it owns, the service frequencies each project offers, and the vehicle types with the container types they service. Products, containers, the fleet and route schemes name these rows.",
    offered: "api",
    instead: { pane: "asset-management" },
    params: ["kind", "record"],
  },
  {
    id: "operations-setup",
    section: "operations",
    label: "Operations setup",
    icon: "sliders-horizontal",
    title: "Operations setup",
    description: "Week numbering, operational master data, maps, areas, zones, and location behavior. The working week and the holiday lists are set per project under Holiday lists.",
    offered: "fixture",
    instead: { pane: "master-data" },
  },
  {
    id: "ticket-comms",
    section: "operations",
    label: "Tickets & communication",
    icon: "bell",
    title: "Tickets and communication",
    description: "Ticket types, lifecycle, actions, SLA, channels, templates, recipients, and inbound routing.",
    offered: "fixture",
    instead: { pane: "tickets", tab: "deadlines" },
  },
  {
    id: "tickets",
    section: "operations",
    label: "Tickets",
    icon: "ticket",
    title: "Tickets",
    description: "Everything about the company's tickets in one place: its types, their teams, deadlines and charges, and the counting rules that open tickets.",
    offered: "api",
    instead: { pane: "ticket-comms" },
    headedBy: "label",
    // In the order a person sets tickets up: what a ticket is, which team works it, by when, at what price, and what opens one.
    tabs: [
      { value: "types", label: "Types" },
      { value: "default-teams", label: "Default teams" },
      { value: "deadlines", label: "Deadlines" },
      { value: "charges", label: "Charges" },
      { value: "counting-rules", label: "Counting rules" },
    ],
    absorbs: { "ticket-types": "types", "ticket-sla": "deadlines", "commercial-ticket-charges": "charges", "counting-rules": "counting-rules" },
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
    offered: "api",
    instead: { pane: "ticket-comms" },
  },
  {
    id: "finance",
    section: "administration",
    label: "Finance & invoicing",
    icon: "credit-card",
    title: "Finance and invoicing",
    description: "VAT, payment references, cadence, bundling, cost centres, accounts, routing rules, and financial integrity.",
    offered: "fixture",
    instead: { pane: "finance-invoicing" },
  },
  {
    id: "finance-invoicing",
    section: "administration",
    label: "Finance & invoicing",
    icon: "credit-card",
    title: "Finance & invoicing",
    description: "What the company's invoices print, and when each project's invoices are due, the payment reference they carry and whether its hires and jobs wait for review.",
    offered: "api",
    instead: { pane: "finance" },
  },
  {
    id: "pricing",
    section: "administration",
    label: "Commercial defaults",
    icon: "tag",
    title: "Commercial defaults",
    description: "One-time commercial setup: company defaults and registries. Price lists are managed in the Commercial section; day-to-day pricing lives in Price Engine.",
    offered: "fixture",
    instead: { pane: "commercial-products" },
  },
  {
    id: "integrations",
    section: "administration",
    label: "Integrations",
    icon: "link-simple",
    title: "Integrations",
    description: "Connection, authentication, ownership, flow direction, mappings, jobs, retries, and support.",
    offered: "fixture",
    instead: { pane: "integrations-on-api" },
  },
  {
    id: "integrations-on-api",
    section: "administration",
    label: "Integrations",
    icon: "link-simple",
    title: "Integrations",
    description: "The services this deployment calls, which way data goes, and their state.",
    offered: "api",
    instead: { pane: "integrations" },
  },
  {
    id: "portals",
    section: "administration",
    label: "Portals & branding",
    icon: "paint-brush",
    title: "Portals and branding",
    description: "Project identity, localized content, customer portal, driver app, banners, actions, and accessibility preview.",
    offered: "fixture",
    instead: { pane: "portals-on-api" },
  },
  {
    id: "portals-on-api",
    section: "administration",
    label: "Portals & branding",
    icon: "paint-brush",
    title: "Portals & branding",
    description: "What each project's residents find on its public pages, and which of its drivers use the Driver App.",
    offered: "api",
    instead: { pane: "portals" },
  },
  {
    id: "commercial-products",
    section: "commercial",
    label: "Products",
    icon: "package",
    title: "Products",
    description: "The sellable catalogue of each project, as the API holds it: what an invoice line calls a product, the code a ledger books it under, and its VAT rate. Prices are rows of a price list, added in Price Engine with Add price.",
    offered: "both",
  },
  {
    id: "commercial-price-lists",
    section: "commercial",
    label: "Price lists",
    icon: "receipt",
    title: "Price lists",
    description: "Each project's tariff and the named lists an agreement is priced under. A list's code and currency are set once, since its rows are quoted in them; a list ends on its last day in force. Price Engine's Add price puts a row in one.",
    offered: "both",
  },
  {
    id: "commercial-visit-rules",
    section: "commercial",
    label: "Recycling-centre charges",
    icon: "recycle",
    title: "Recycling-centre charges",
    description: "How a project's recycling-centre visits are charged: a household's free visits a year and the price of each after them, the fractions brought free, and a business's visit.",
    offered: "api",
  },
  {
    id: "pickup-exception-charges",
    section: "commercial",
    label: "Exception charges",
    icon: "warning",
    title: "Exception charges",
    description: "What a collection missed for the customer, or collected tagged with a contaminant code, costs them: how many are free over a window, then the products charged by occurrence.",
    offered: "api",
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

const modeOf = (configured: boolean): SettingsMode => (configured ? "api" : "fixture")

const offeredIn = (offered: SettingsMode | "both" | undefined, mode: SettingsMode): boolean => offered === undefined || offered === "both" || offered === mode

export function settingsPaneOf(id: string | undefined): SettingsPane | undefined {
  return SETTINGS_PANES.find((pane) => pane.id === id)
}

export function settingsPane(id: SettingsPaneId): SettingsPane {
  const pane = settingsPaneOf(id)
  if (pane === undefined) throw new Error(`No Settings pane ${id}`)
  return pane
}

/** Whether the nav offers a pane, with the adapter configured or not. */
export function settingsPaneOffered(paneId: string, configured: boolean): boolean {
  const pane = settingsPaneOf(paneId)
  return pane !== undefined && offeredIn(pane.offered, modeOf(configured))
}

/** A pane's tabs its mode offers. */
export function settingsTabsOffered(paneId: SettingsPaneId, configured: boolean): NonNullable<SettingsPane["tabs"]> {
  return (settingsPane(paneId).tabs ?? []).filter((tab) => offeredIn(tab.offered, modeOf(configured)))
}

/** The params `given` holds that the pane reads in this mode: its own, and a tab it offers. */
function paramsRead(pane: SettingsPane, given: Readonly<Record<string, string | null | undefined>>, configured: boolean): SettingsParams {
  const read: Partial<Record<SettingsParam | "tab", string>> = {}
  for (const param of pane.params ?? []) {
    const value = given[param]
    if (typeof value === "string" && value !== "") read[param] = value
  }
  const tab = given.tab
  if (typeof tab === "string" && settingsTabsOffered(pane.id, configured).some((offered) => offered.value === tab)) read.tab = tab
  return read
}

/**
 * The pane an address shows, with the adapter configured or not, and the
 * params it reads: a retired pane's id opens the pane that absorbed it at its
 * tab; a pane its mode does not offer opens the one it names `instead`; an id
 * no pane answers to, or a pane with nowhere to land, opens the default pane.
 */
export function settingsAddressShown(requested: string | undefined, given: Readonly<Record<string, string | null | undefined>>, configured: boolean): SettingsAddress {
  const mode = modeOf(configured)
  const absorbing = requested === undefined ? undefined : SETTINGS_PANES.find((pane) => pane.absorbs !== undefined && Object.hasOwn(pane.absorbs, requested))
  let pane = absorbing ?? settingsPaneOf(requested)
  let params: Readonly<Record<string, string | null | undefined>> = absorbing === undefined ? given : { ...given, tab: absorbing.absorbs?.[requested ?? ""] }
  if (pane !== undefined && !offeredIn(pane.offered, mode)) {
    const instead = pane.instead
    pane = instead === undefined ? undefined : settingsPaneOf(instead.pane)
    params = { tab: instead?.tab }
  }
  if (pane === undefined || !offeredIn(pane.offered, mode)) return { pane: DEFAULT_SETTINGS_PANE, params: {} }
  return { pane: pane.id, params: paramsRead(pane, params, configured) }
}

/** The bar above a pane: its section, or the pane itself where its tabs or records title themselves. */
export function settingsPaneHeading(pane: SettingsPane): string {
  return pane.headedBy === "label" ? pane.label : (SETTINGS_SECTIONS.find((section) => section.id === pane.section)?.label ?? pane.label)
}

/**
 * The nav: each section with the panes its mode offers, those the search
 * finds where a person typed one — by label, title, description, terms, and
 * `moreTerms`, the words a pane's own content says.
 */
export function settingsNav(configured: boolean, search: string, moreTerms: (paneId: SettingsPaneId) => readonly string[] = () => []) {
  const needle = search.trim().toLowerCase()
  const found = (pane: SettingsPane) => needle === "" || [pane.label, pane.title, pane.description, ...(pane.terms ?? []), ...moreTerms(pane.id)].join(" ").toLowerCase().includes(needle)
  return SETTINGS_SECTIONS.map((section) => ({
    ...section,
    panes: SETTINGS_PANES.filter((pane) => pane.section === section.id && offeredIn(pane.offered, modeOf(configured)) && found(pane)),
  })).filter((section) => needle === "" || section.panes.length > 0)
}

/** A Settings address: the pane, the params of its own it is given (others are left out), and `from`, where Back to app returns, unless that is the start. */
export function settingsHref<Id extends SettingsPaneId>(paneId: Id, params?: SettingsParamsOf<Id>): string {
  return hrefOf(paneId, params ?? {})
}

/** The address of what Settings shows, `from` where Back to app returns. */
export function settingsAddressHref(address: SettingsAddress, from: string): string {
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
