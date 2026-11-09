"use client"

// What draws each pane of the Settings table (lib/modules/settings-panes.ts),
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

import type { SettingsPaneIcon, SettingsPaneId, SettingsPaneProps } from "@/lib/modules/settings-panes"

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

export const SETTINGS_PANE_VIEWS: Record<SettingsPaneId, ComponentType<SettingsPaneProps>> = {
  account: dynamic(() => import("./fixture-settings").then((module) => module.AccountSettings)),
  "notifications-on-api": dynamic(() => import("./notifications-settings-on-api").then((module) => module.NotificationsSettingsOnApi)),
  access: dynamic(() => import("./organization-access-management").then((module) => module.OrganizationAccessManagement)),
  areas: dynamic(() => import("./planning-areas-settings").then((module) => module.PlanningAreasSettings)),
  "collection-calendars": dynamic(() => import("./collection-calendars-settings").then((module) => module.CollectionCalendarsSettings)),
  "holiday-lists": dynamic(() => import("./holiday-lists-settings").then((module) => module.HolidayListsSettings)),
  "operations-bulky-schedules": dynamic(() => import("./bulky-schedules-settings").then((module) => module.BulkySchedulesSettings)),
  "master-data": dynamic(() => import("./master-data-settings").then((module) => module.MasterDataSettings)),
  tickets: dynamic(() => import("./tickets-settings").then((module) => module.TicketsSettings)),
  "message-templates": dynamic(() => import("./message-templates-settings").then((module) => module.MessageTemplatesSettings)),
  "finance-invoicing": dynamic(() => import("./finance-settings-on-api").then((module) => module.FinanceSettingsOnApi)),
  "integrations-on-api": dynamic(() => import("./integrations-settings-on-api").then((module) => module.IntegrationsSettingsOnApi)),
  "portals-on-api": dynamic(() => import("./portals-settings-on-api").then((module) => module.PortalsSettingsOnApi)),
  "commercial-products": dynamic(() => import("./commercial-catalogue-panes").then((module) => module.ProductsPane)),
  "commercial-price-lists": dynamic(() => import("./commercial-catalogue-panes").then((module) => module.PriceListsPane)),
  "commercial-visit-rules": dynamic(() => import("./visit-rules-settings").then((module) => module.VisitRulesSettings)),
  "pickup-exception-charges": dynamic(() => import("./pickup-exception-charges-settings").then((module) => module.PickupExceptionChargesSettings)),
}
