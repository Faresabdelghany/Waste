# Real WasteHero: the Pickup Setting → Calendar → Days → Route chain

Researched 2026-08-30 from **public sources only**: help.wastehero.io (Intercom help center, Platform collection), docs.wastehero.io (REST API v3 reference incl. raw OpenAPI schemas), wastehero.io marketing pages (some recovered via Wayback Machine — the live site was redesigned in 2026 and old product pages 404). No app login was used. Quoted passages were returned as exact quotes by the fetch pass. Purpose: answer the open questions in `docs/specs/REAL_PRODUCT_CONVERGENCE.md` (issue #15).

## The chain is four layers, not three

> "The pickup setting defines the rules for collection but does not include actual dates. Dates will be set using a Collection Calendar." — [Create and use a new pickup setting](https://help.wastehero.io/en/articles/11830260-create-and-use-a-new-pickup-setting)

1. **Pickup Setting** — reusable, project-scoped frequency rules, no dates.
2. **Collection Calendar** — the weekday pattern + anchor (start week/date) inside a pickup setting; Regular or Combined (seasonal).
3. **Collection Calendar Days** — the **materialized, first-class, editable date records** generated (or manually added) from a calendar. This layer was missing from the repo's previously recorded three-layer chain.
4. **Routes** — Plan Ahead (batch horizon) or Optimize (one date) consume the Days; the Route Scheme supplies vehicle/driver rules and collection mode; stops auto-fill by waste fraction + vehicle type.

## 1. Pickup Setting

**Help-center creation form** (Settings → Operation Management → Pickup Settings): Project, Name, **Collections per week**; if 1 → "**Weeks between**" ("e.g., every 2 weeks"); if >1 → "**Days between**" ("e.g., every 3 days"). Weekday selection happens on the calendar, and "The number of selected days **must match** the **Collections per Week**".

**API object** (`PickupSettingOutputSerializerV3`, [pickup_settings](https://docs.wastehero.io/reference/get_pickup_settings_api_v3_pickup_settings__get-1.md)) is richer than the form: `pickup_method`, `container_status` (required); `project`, `name`, `emptying_interval_from/to`, `exclude_days` (glossed "array of days to skip" in the [pickup_order reference](https://docs.wastehero.io/reference/get_pickup_orders_api_v3_pickup_order__get-1.md); the pickup_settings schema types it only as an array of strings), `fixed_pickups_period`, `pickup_interval`, `pickup_repeat_period`, `allowed_hours_from/to`, `amount_days_between_pickups`, `minimum_days_between_pickup`, `collection_per_week`, `first_collection` (date). Time windows, a skip list, a minimum-gap constraint, and an anchor date exist at the API level; none of the enum values are publicly documented.

**One record, two roles — confirmed.** The same record is:
- selected on **containers** at creation ("Pickup Method, Status, **Pickup Setting**" — [Working with containers](https://help.wastehero.io/en/articles/12049765-working-with-containers));
- linked from **products** ("the new product will then be linked to the selected pickup setting. This step allows you to assign the new pickup setting to actual containers") and **required on container prices**: `ContainerPriceOutputSerializerV3` has `pickup_setting` in its *required* list, alongside `waste_fraction`, `container_type`, `amount`, and a separate `recurring_interval` (default 12) for billing ([container_price](https://docs.wastehero.io/reference/get_container_prices_api_v3_container_price__get-1.md));
- the parent of the Collection Calendars that route generation consumes (Plan Ahead prerequisite).

**No monthly frequency exists publicly.** The model is strictly week-based (collections/week + weeks-between or days-between). "Weeks between" is an integer interval, so every-3-weeks and every-4-weeks appear natively expressible (inference from the field's shape; no documented example beyond "e.g., every 2 weeks").

## 2. Collection Calendar

> "A collection calendar is a powerful function for you to regulate pickup date (Mon-Sun) and pickup frequency within a pickup setting." — [Collection calendars](https://help.wastehero.io/en/articles/10064897-collection-calendars)

- **Regular**: "a fixed pickup frequency and date (Mon-Sun)" — fields: **Week** ("Indicates the week of the year when the collection cycle starts (e.g., Week 1, Week 8)") — presets managed in a **Collection Weeks** tab — **Start date** ("Select a date within the week"), **Week days** (count bound to Collections per week). Can be flagged "Only allowed to use in combined collection calendar".
- **Combined**: "a more dynamic way to control the pickup frequency within a certain period" — aggregates multiple regular calendars ("including regular collection calendars from other pickup settings"), periods "cannot be overlapped". This is how **seasonal frequency** (summer-house patterns) is modelled.
- Both give a visual preview of resulting collection dates.

**Fortnightly anchoring: anchor-based, not parity-based.** Which fortnight a 2-weekly cadence serves is fixed by the calendar's start Week + Start date. No odd/even ISO-parity toggle exists anywhere public.

## 3. Collection Calendar Days

Dates are **data, not a function**: bulk-generated ("three-dot menu → **Generate Dates** → fill in the Period End") or manually added, then kept as editable records:

> "Here you will see all the generated pickup days. You can also manually edit these dates - for example, to adjust for public holidays or special events."

> "Here you can see all collection dates that have been created and added to calendars, along with the Pickup Settings they are associated with. You can edit or delete these dates." — [Operation management settings](https://help.wastehero.io/en/articles/12164864-operation-management-settings)

**Holiday handling is manual date editing** — no holiday calendar, automatic skip, or shift rule is documented publicly (checked English, Danish, Finnish help centers; marketing claims of "holiday adjustments" could not be verified on-page).

**Collection Deviations exists in the real product.** A dedicated Settings → Operation Management tab, documented publicly in just two lines: the tab-list description "Collection Deviations — Add, edit, or delete exceptions to regular schedules" and the how-to sentence "You can view, edit, delete, or add new collection deviations by pressing Action". The record's shape — original date, replacement date, scope, promise preservation — is not publicly documented, and no deviation endpoint exists in the public API index. (Marketing's "deviations & exceptions" — missed collections, access problems, contamination — is a different, execution-day concept.)

## 4. Route Scheme, Plan Ahead, Optimize

> "A route scheme defines a set of rules that apply to each route. For example, it specifies which vehicle and driver combination will use the route. You can also configure the route's collection mode … whether you're collecting containers or replacing them." — [Route schemes](https://help.wastehero.io/en/articles/11830270-route-schemes)

- Scheme = vehicle/driver rules + collection mode; "configure the route scheme once … create multiple routes from it". The public API serializer exposes only `id` and `name`. No cadence, calendar, or geography fields are documented on the scheme (Areas is a separate settings tab; no article ties it to stop selection).
- **Plan Ahead** (auto): "plan routes several days in advance. Whether you want to plan 7 days or two weeks ahead (or anything else you can imagine)". Prerequisite: "You must configure Pickup Settings and Collection Calendar Days before using this feature." Afterwards: "you can modify them individually as needed **without any restrictions**."
- **Optimize** (manual): scheme three-dot menu → Optimize → "Choose the date for which you want to create the route" → one dated route.
- **Stops**: "The newly created route will automatically be filled with all relevant stops, based on parameters such as waste fraction and vehicle type. This stop assignment depends heavily on your configuration." Stop order comes from "our advanced routing engine"; manual removal and reordering allowed. API: routes carry a single `waste_fraction`, `scheduled_day`, `locked`, `auto_optimize` (default true); stops are container stops or ticket stops (`PUT /route/{id}/add_stop`); no route status enum (Reopen keeps data, Reset erases it).
- Only **Active-status containers** "can be planned into routes"; agreement status drives container status, not vice versa ([status sync](https://help.wastehero.io/en/articles/9154641-container-and-agreement-status-sync)).

## 5. Where the customer's frequency promise lives

- **Not on the agreement**: `AgreementOutputSerializerV3` = `id`, `container`, `quantity`, `start_date`, `end_date`, `property` — no frequency field. The property record has none either.
- The agreement **displays** what it inherits: "Each agreement includes detailed information such as: Status, Waste fraction, Container type, **Pickup scheme**, **Collection calendar**, **Route scheme**" ([Properties overview](https://help.wastehero.io/en/articles/11813696-properties-a-brief-overview)) — note the "Pickup scheme" naming wobble.
- The promise is **authored once as the Pickup Setting and reaches the customer through product → container**; the agreement binds container + property + period. Per-agreement resolved dates are queryable: `GET /api/v3/agreement/{id}/available_days?period_start&period_end` → array of ISO dates.
- **Citizen-facing**: collection notifications are per **container** ("On the subscription page, you will see a list of containers", N-days-ahead SMS/email); the portal shows agreements/orders/invoices; marketing confirms citizens can request "changing their pickup frequency" via the portal (request → ticket; no documented record-edit flow).
- **Billing frequency is separate** from pickup frequency: `recurring_interval` on the price record vs `collection_per_week` on the pickup setting. Since 2026 Q3, products/pricing live under Settings → **Contract Management** ("container, service and recurring products and price lists").
- **Timezone** is a company-level system preference ("Time zone – set the default time zone (e.g., Europe/Copenhagen)"), not a calendar property. No working-day concept is documented on calendars.

## Answers to REAL_PRODUCT_CONVERGENCE.md open questions

| OQ | Answer |
|---|---|
| 1. Pickup Setting: one record or two roles? | **One record.** Routing (parent of calendars) and catalogue/pricing (`ContainerPrice.pickup_setting` required) share the same project-scoped entity. |
| 2. Where does the promise attribute live? | **A reusable frequency record referenced by product and container** — not the agreement (its API object has no frequency field; it displays inherited values). |
| 3. Fortnightly: anchor or parity? | **Anchor-based** (calendar start Week + Start date). No odd/even parity toggle is documented publicly — the prototype's parity model is its own invention, as is its 53-week-year behavior. |
| 4. Monthly semantics? | **No monthly frequency exists** publicly. Real vocabulary: collections/week + integer weeks-between or days-between. The prototype's `monthly` has no real counterpart; every-3/4-weeks (natively expressible there, by inference) has no prototype counterpart. |
| 5. Date-exception mechanism? | **Collection Deviations exists by that name** (settings tab, shape undocumented), alongside direct manual editing of Collection Calendar Days and an API-level `exclude_days` skip list. No automatic holiday handling is documented. |

## Still unanswered (needs a logged-in dev-app session)

- The Collection Deviation record's fields and semantics (original/replacement date, scope, promise preservation).
- The exact Route Scheme field list (help article: "highly customizable"; API exposes id+name) — whether geography/fraction/container-type parameters live on the scheme.
- Plan Ahead's exact mechanics (trigger model, one route per scheme per day?) — the route-schemes article's prerequisite-configuration "Learn more" link is an internal Intercom URL, and no public Plan Ahead article was found.
- Whether "Collection Weeks" records carry more than a start-week number (the parity question can't be fully closed without seeing them).
- Which record the portal/notifications read frequency and next dates from.
- Enum values for `pickup_method`, `pickup_interval`, `fixed_pickups_period`; `recurring_interval` units; whether `available_days` folds deviations in.
- Whether the live app hides a monthly mode the help center doesn't document.

## Source index

help.wastehero.io articles: [11830260 pickup setting](https://help.wastehero.io/en/articles/11830260-create-and-use-a-new-pickup-setting) · [10064897 collection calendars](https://help.wastehero.io/en/articles/10064897-collection-calendars) · [12164864 operation management settings](https://help.wastehero.io/en/articles/12164864-operation-management-settings) · [11830270 route schemes](https://help.wastehero.io/en/articles/11830270-route-schemes) · [12049765 working with containers](https://help.wastehero.io/en/articles/12049765-working-with-containers) · [11813696 properties overview](https://help.wastehero.io/en/articles/11813696-properties-a-brief-overview) · [9154641 status sync](https://help.wastehero.io/en/articles/9154641-container-and-agreement-status-sync) · [11814042 add container to property](https://help.wastehero.io/en/articles/11814042-how-to-add-a-container-to-a-property) · [11937178 self-service](https://help.wastehero.io/en/articles/11937178-how-to-use-self-service) · [11928108 SMS/email subscriptions](https://help.wastehero.io/en/articles/11928108-how-to-manage-your-sms-and-email-subscriptions) · [15284544 portal order to ticket](https://help.wastehero.io/en/articles/15284544-extra-emptying-from-portal-order-to-ticket-completion) · [9795806 reopen/reset](https://help.wastehero.io/en/articles/9795806-reopen-reset-routes-and-stops) · release notes [2025 Q1](https://help.wastehero.io/en/articles/9790836-release-notes-2025-q1) / [2025 Q4](https://help.wastehero.io/en/articles/12801774-release-notes-2025-q4) / [2026 Q3](https://help.wastehero.io/en/articles/16170684-release-notes-2026-q3).
docs.wastehero.io references: pickup_settings, container_price, container, agreement (+ available_days), property, route, route_scheme, pickup_order, pickup_day GET schemas; guides "Creating a route", "Adding stops to a route", "Move stops on route".
Archived marketing: [customer-relationship-management](http://web.archive.org/web/20260123074056/https://wastehero.io/customer-relationship-management/), customer-portal (Wayback, Jan 2026); live [wastehero.io](https://wastehero.io/) homepage.
