"use client"

// What draws each pane of the Settings table (lib/data/settings-panes.ts),
// loaded when the pane is first shown, and the glyph of each icon the table
// names. Every view takes the same props, so the shell never learns how a
// pane navigates: a pane's own state travels in the params it declares.

import type { ComponentType } from "react"
import dynamic from "next/dynamic"
import {
  Bell,
  CalendarBlank,
  CalendarCheck,
  Couch,
  CreditCard,
  Database,
  EnvelopeSimple,
  Gear,
  LinkSimple,
  MapTrifold,
  Package,
  PaintBrush,
  Receipt,
  Recycle,
  SlidersHorizontal,
  SquaresFour,
  Tag,
  Ticket,
  UserCircle,
  UsersThree,
  Warning,
} from "@phosphor-icons/react/dist/ssr"

import type { SettingsPaneIcon, SettingsPaneId, SettingsParams } from "@/lib/data/settings-panes"

export type SettingsPaneProps = {
  paneId: SettingsPaneId
  /** The params of its own the address gives it. */
  params: SettingsParams
  /** Moves its params, in place in the address, or as a new entry Back returns from. */
  onParamsChange: (params: SettingsParams, how?: "push" | "replace") => void
  onOpenPane: (paneId: SettingsPaneId, params?: SettingsParams) => void
}

export const SETTINGS_PANE_ICONS: Record<SettingsPaneIcon, ComponentType<{ className?: string }>> = {
  bell: Bell,
  "calendar-blank": CalendarBlank,
  "calendar-check": CalendarCheck,
  couch: Couch,
  "credit-card": CreditCard,
  database: Database,
  "envelope-simple": EnvelopeSimple,
  gear: Gear,
  "link-simple": LinkSimple,
  "map-trifold": MapTrifold,
  package: Package,
  "paint-brush": PaintBrush,
  receipt: Receipt,
  recycle: Recycle,
  "sliders-horizontal": SlidersHorizontal,
  "squares-four": SquaresFour,
  tag: Tag,
  ticket: Ticket,
  "user-circle": UserCircle,
  "users-three": UsersThree,
  warning: Warning,
}

const fixtureForm = dynamic(() => import("./fixture-settings").then((module) => module.FixtureSettingsPane))

export const SETTINGS_PANE_VIEWS: Record<SettingsPaneId, ComponentType<SettingsPaneProps>> = {
  account: dynamic(() => import("./fixture-settings").then((module) => module.AccountSettings)),
  notifications: fixtureForm,
  "notifications-on-api": dynamic(() => import("./notifications-settings-on-api").then((module) => module.NotificationsSettingsOnApi)),
  company: dynamic(() => import("./company-projects-management").then((module) => module.CompanyProjectsManagement)),
  access: dynamic(() => import("./organization-access-management").then((module) => module.OrganizationAccessManagement)),
  "asset-management": dynamic(() => import("./asset-management-settings").then((module) => module.AssetManagementSettings)),
  areas: dynamic(() => import("./planning-areas-settings").then((module) => module.PlanningAreasSettings)),
  "collection-calendars": dynamic(() => import("./collection-calendars-settings").then((module) => module.CollectionCalendarsSettings)),
  "holiday-lists": dynamic(() => import("./holiday-lists-settings").then((module) => module.HolidayListsSettings)),
  "operations-bulky-schedules": dynamic(() => import("./bulky-schedules-settings").then((module) => module.BulkySchedulesSettings)),
  "master-data": dynamic(() => import("./master-data-settings").then((module) => module.MasterDataSettings)),
  "operations-setup": fixtureForm,
  "ticket-comms": fixtureForm,
  tickets: dynamic(() => import("./tickets-settings").then((module) => module.TicketsSettings)),
  "message-templates": dynamic(() => import("./message-templates-settings").then((module) => module.MessageTemplatesSettings)),
  finance: fixtureForm,
  "finance-invoicing": dynamic(() => import("./finance-settings-on-api").then((module) => module.FinanceSettingsOnApi)),
  pricing: dynamic(() => import("./fixture-settings").then((module) => module.CommercialDefaultsSettings)),
  integrations: fixtureForm,
  "integrations-on-api": dynamic(() => import("./integrations-settings-on-api").then((module) => module.IntegrationsSettingsOnApi)),
  portals: fixtureForm,
  "portals-on-api": dynamic(() => import("./portals-settings-on-api").then((module) => module.PortalsSettingsOnApi)),
  "commercial-products": dynamic(() => import("./commercial-settings").then((module) => module.ProductsByModePane)),
  "commercial-price-lists": dynamic(() => import("./commercial-catalogue-panes").then((module) => module.PriceListsPane)),
  "commercial-visit-rules": dynamic(() => import("./visit-rules-settings").then((module) => module.VisitRulesSettings)),
  "pickup-exception-charges": dynamic(() => import("./pickup-exception-charges-settings").then((module) => module.PickupExceptionChargesSettings)),
}
