# Products & Prices redesign — design spec

- **Date:** 2026-08-19
- **Status:** Approved by Fares in brainstorming session (interactive decisions logged below). Prototype variant verdict recorded — see §10. Next step: implementation plan via the `writing-plans` skill.
- **Sources:** live-app research in `docs/research/PRODUCTS_AND_PRICES.md` (+ `pp-*.png` screenshots in the same folder); adversarial design panel (3 independent redesigns, each critiqued); brainstorm mockups in `.superpowers/brainstorm/` (gitignored).

## 1. Purpose

Bring the WasteHero **Products & prices** capability (real app: Settings → Products & prices) into this prototype — but with a **redesigned, simpler process**, not a port. The prototype's job is to argue for a better workflow than the live module. This closes the `docs/BUSINESS_MODULE_MAP.md` priority gap P1 on M05 (price check, service levels, service provider prices, bulk tools, history…), on the prototype's own terms.

## 2. Problem: why the real module feels complicated

1. **One price lives in four places** — base fee on the product, pickup price in a price list, extras on the product's Extras tab, surcharges in Setup. "What does this customer pay?" requires a simulator.
2. **Setup demands ~8 concepts before the first sale** (templates, categories, materials, service levels, price lists, surcharge rules, VAT config, simulator).
3. **Duplication** — invoice name/code + VAT on both product and price row; price lists listed under both Prices and Setup; templates/categories/types are three names for one axis.
4. **Two unrelated mental models share one tab** — customer pricing (best-match condition rows) vs service provider pricing (bid/current fee + indexed components).

Essential complexity that must survive: prices genuinely vary by zone/customer type; negotiated deals exist; changes are scheduled and bulk-adjusted; the service provider bid is contractually immutable; VAT/invoice fields must reach accounting; everything effective-dated and auditable.

## 3. Decisions made (brainstorm log)

| # | Decision | Choice |
|---|----------|--------|
| 0 | Overall direction | **"Two Lanes"** (progressive disclosure) as backbone, with patches from the adversarial critiques |
| 1 | Customer pricing surface | **Products table is the price list** — default price inline on the row; variations behind the product |
| 2 | Service provider prices shape | **Flat table** (one row per service provider × product × service area), surfaced in **two places**: a Commercial module *and* a new Prices tab on the Service provider details page |
| 3 | Product detail | **Full-page detail** (Route-details precedent), not the generic side sheet |
| 4 | Price list term | **Survives as a tag on price rows + a read-mostly index in /settings** (never deleted — it is canonical vocabulary in `CONTEXT.md`) |

Consensus moves adopted from all three panel designs: SELL/PAY split; Setup hub dissolved (inline creation + settings registries); VAT + invoice name/code live once, on the product; templates/categories/types collapse to 3 fixed product types; a product is born priced; "Explain a price" is first-class and launchable from invoice lines.

Critique patches folded in: negotiated rows **excluded by default** from bulk adjustments; one written tie-break rule (§4.4); the PAY module is named **"Service provider prices"** (canonical term — never "rates"); the Price list term survives (§4.6).

## 4. Design

### 4.1 Information architecture

**Commercial workspace** (recurring daily work), pill-tab modules:

1. **Products** — the SELL lane. Absorbs the old `pricing` module (price lists + price check). The catalogue table *is* the price list.
2. **Service provider prices** — the PAY lane, new module. Deliberately separate from Settlements (domain-map rule: service provider price and settlement are separate records) and from customer pricing entirely.
3. **Settlements / Events / Billing / Invoices** — unchanged, except invoice lines become clickable → "Explain a price" (§4.5).

**Service providers workspace** — the existing Service provider details full page gains a **Prices tab**: the same service-provider-price records filtered by `serviceProviderId` (read + link into the Commercial module). Matches how procurement thinks (service-provider-first) without a second data model.

**/settings → "Commercial defaults" pane** (things done once; expose the existing hidden `pricing` pane under this name):

- Company defaults: currency, default VAT rate(s), invoice code prefix.
- Read-mostly registries of things created inline elsewhere: zones, customer types, materials, service levels (for rename/merge/retire — the janitorial views).
- Surcharge rules (holiday/weekend, %, or fixed; highest wins on overlap).
- Service provider performance parameters as a **read-only card**: coefficient = 1 + a × (b − complaint share), reliability gate, cap (fixture values; no editor).
- **Price lists index** (§4.6).

Gone as surfaces: the Products|Prices|Setup tab triad, the Setup hub's five cards, the standalone simulator page, template/category schema configuration.

### 4.2 SELL lane — Products module

**Table columns:** Name · Type (3 fixed: Container collection / Recurring service / Additional service) · Price (default price, inline-editable, unit-typed: €/pickup, €/month, €/job) · VAT · Variations (count badge) · Status. Filterable by type, status, price-list tag, zone.

**Header actions:** `+ New product`, `Adjust prices`, `Explain a price`.

**Full-page product detail** (replaces the workspace body; Route-details precedent), sections top-to-bottom:

1. Header strip: name, type badge, status badge, back to Products; actions `Explain a price`, `Edit`.
2. **Price** — table: default row ("Everyone") + variation rows, each showing amount, condition chips (zone, customer type, container type, waste fraction), effective from/to, negotiated flag (🤝 + customer name, visually locked). Buttons: **Vary this price** (adds a condition row; condition values creatable inline), **Schedule a change** (effective-from/until + optional auto-revert), **Negotiated deal** (customer-scoped override row; also surfaced on that customer's Agreement record as a related entry).
3. **Invoice & tax** — invoice name, invoice code, VAT rate + computed incl-VAT price. **The only home of these fields.** Per-row override exists only behind an explicit "Override invoice details" disclosure on a variation row.
4. **Extras** (collapsed by default) — materials/BOM, linked additional services, service levels; every picker has "+ Create new" inline.
5. **History** — this product's audit trail (creations, edits, adjustments) with field-level old → new diffs.

**New product** — reuses the Quick create / Guided setup chooser (route-create-flow precedent):

- *Quick create*: one form (name, type, price + unit, VAT prefilled from settings, invoice name/code auto-suggested) → review → create. **A product is born priced** — no conditions = applies to everyone.
- *Guided setup*: left-rail stepper adding optional Variations and Schedule steps.

**Adjust prices** (bulk; the annual-increase flow): select rows in the table (or select-all after filtering) → dialog: +%/−%/fixed/multiply, optional rounding rule, effective date, optional auto-revert date → **review step: full old → new diff table** → confirm. **Negotiated rows are excluded by default** (explicit opt-in checkbox to include them, with a warning). Affected rows show a "Scheduled" chip until the date.

### 4.3 PAY lane — Service provider prices module

**Table columns:** Service provider · Product · Service area · **Bid** (🔒 immutable) · **Current fee** (with last-index annotation, e.g. "CPI +5%") · Valid from/until · Last indexed. One row per service provider × product × service area.

**Header actions:** `+ New service provider price`, `Apply index`.

**Apply index** — mirrors Adjust prices so one learned pattern covers both lanes: select rows / filter by service provider or service area → index % (CPI/fuel), **base = original bid or current fee** (current compounds earlier changes; bid never moves), effective date → review computed new current fees per row → confirm. Each run appends an entry to the row's indexation history.

**Rate detail** — the standard record detail sheet: facts show bid, current fee, validity, itemised fee components (flat € / % lines), metered lines (rate × measured monthly quantity — displayed as static fixture data), and the indexation timeline in related entries. Bid immutability is a stated rule + UI lock (no edit path for the bid after creation).

**Second surface:** Service provider details page → **Prices tab** rendering the same records filtered by that service provider, grouped by service area, with a link into the module.

### 4.4 Price resolution rule (written once, shown in UI)

Displayed inline above variation rows and used by Explain a price:

> The row matching the **most conditions** wins. A **negotiated row for the specific customer always wins**. Remaining ties go to the row with the **newest effective-from date**.

### 4.5 Explain a price

Launchable from (a) the Products header action, (b) the product detail header, (c) **clicking any invoice line amount** in the Invoices module. Input: customer (or zone + customer type), product, date. Output sheet: the winning row highlighted with its matched conditions, losing rows greyed with the disqualifying condition named, then the line math — price, surcharge (if a rule matches the date), VAT → total. Every element links to the record that produced it. This replaces the real app's Setup-buried simulator.

### 4.6 Price lists as tags

- Every price row (default or variation) may carry **one Price list tag** (e.g. `PL-Copenhagen-2026`, `Negotiated · Østerbro Housing`).
- The Products table and product detail can filter/group by tag.
- **/settings → Commercial defaults → Price lists**: a read-mostly index (name, row count, effective from, status derived from its rows) linking to filtered views. This keeps the canonical glossary term and the "annual tariff as a document" story without a lifecycle container object.

## 5. Prototype implementation mapping

Known constraints from the codebase (verified 2026-08-19 by parallel exploration):

- **Module registry** — `lib/data/business-modules.ts` (~4200 lines): `ModuleDefinition {id, label, title, description, entityLabel, contextLabel, valueLabel, primaryAction, metrics, records, lifecycle, rules}`. New fixture record ids **must** be registered in one of the scope arrays (`copenhagenFixtureRecordIds` / `harborFixtureRecordIds` / `companyWideFixtureRecordIds`) or `record()` throws. Service provider-owned records also map in `fixtureServiceProviderIdByRecordId`.
- **Schema integrity gate** — `lib/data/business-form-schemas.ts` throws unless there is **exactly one form schema per public workspace module** per `business-domain.ts`'s `publicWorkspaceDomains`. Retiring `commercial.pricing` and adding `commercial.service-provider-prices` (and any hidden `price-rows` module) therefore requires touching `business-domain.ts` and the schema files together. Schemas live in `lib/data/business-form-schemas-commercial-improve.ts`.
- **Registry changes:** rework the `products` module (labels, columns via facts, metrics, rules); retire `pricing` as a nav tab (its Price-check rule text moves to Products); add `service-provider-prices`; update `primaryModuleIdsByWorkspace` (business-workspace.tsx ~line 537) for commercial: `products, service-provider-prices, settlements, events` (billing/invoices in More).
- **Price rows as records:** the default price is itself a price-row record with no conditions ("Everyone") — the Products table's Price column reads it, so there is exactly one price model, not a product field plus rows. Rows live in a support module `commercial.price-rows`, hidden from nav (precedent: `operate.driver-app` is "retained as data contract, hidden from office nav"; commercial gets a `publicModuleIdsByWorkspace` allowlist in `workspace-page-shell.tsx` if needed). Each row links to its product via `relationRefs` (`{fieldId: 'productId', workspaceId: 'commercial', moduleId: 'products', recordId}`); facts carry amount, conditions, effective dates, negotiated flag, price-list tag. The product detail page reads them from the record store.
- **Full-page product detail:** new component, wired via the existing full-page ternary in `business-workspace.tsx` (~line 2596, `isRouteDetails` / `isServiceProviderDetails` precedent) — add `isProductDetails`. Cross-record data (variations, extras) computed in BusinessWorkspace and passed down, like ServiceProviderDetailsPage receives its related arrays.
- **Service provider details Prices tab:** extend `components/wastehero/service-provider-details-page.tsx` (RouteDetailsPage already demonstrates local Tabs).
- **Create flows:** Quick create = existing `BusinessRecordFormDialog` two-step (`execution.reviewBeforeSubmit: true`); Guided setup + Adjust prices + Apply index reuse the route-create-flow chooser/stepper components (`components/wastehero/route-create-flow.tsx`, `components/project-wizard/Stepper.tsx`). Bulk flows write via the store like `handleGuidedRouteCreate` does.
- **Settings pane:** expose the hidden `pricing` pane in `components/settings/SettingsDialog.tsx` (`settingsSections` + `visiblePaneDefinitions`) as "Commercial defaults", delegating to a custom full-bleed component (company/access/asset-management precedent).
- **Persistence:** all records via `BusinessRecordStoreProvider` (localStorage `wastehero-business-records-v1`). Bid immutability, negotiated-exclusion, and the tie-break rule are client-side conventions enforced in UI code.
- **Fixtures must be honest:** several products with 3–6 variations each (zones, customer types, one negotiated), one scheduled change, service provider prices for both fixture service providers (NordRen CA-Ø-2, CityHaul CA-AM-1) with at least one indexed row — so the demo shows municipal-scale reality, not a toy.

## 6. Conscious cuts (deferred, not forgotten)

- xlsx import/export of products and prices.
- Product template schema configuration (3 fixed types instead).
- Minimum charge per price row.
- Long-tail condition dimensions: service responsibility, pickup setting, property type (the condition-row pattern extends to them without redesign).
- Service provider performance formula **editing** and per-exception-type pay effects (read-only parameter card only; coefficient still appears on settlement fixtures).
- Global cross-entity audit browser (per-product/per-rate History + a settings export link instead).
- Metered-line quantity capture (belongs to Settlements/Billable Events).
- Sell-vs-pay **margin strip** on the product page — a good later idea from the "One Product, One Page" design; out of v1.
- Named revertible **change sets** (from "The Pricing Desk") — out of v1; the Adjust-prices audit entries cover the basic story.

## 7. Glossary compliance (`CONTEXT.md` is canonical)

Use: **Product / Service**, **Price list** (as the tag/index name), **Agreement** (customer entitlement — never "Subscription"), **Service provider price** (never "rates"), **Service Area** (never "operational area" for awards), **Settlement** (never merged with service provider prices), **Billable Event**, **Invoice**. Zones as customer-price conditions are Plan-owned operational geography — distinct from Service Areas.

## 8. Risks & mitigations (from the adversarial critiques)

| Risk | Mitigation in this design |
|---|---|
| Bulk +3% silently sweeps negotiated deals | Excluded by default; explicit opt-in with warning |
| Tie between equally specific rows | Written tie-break rule (§4.4), shown in UI |
| "Price list" deletion invites rebuttal | Term survives as tag + settings index |
| Contract-first bid entry (20 products at once) | Service provider details Prices tab + (later) a multi-product step in the New service provider price flow |
| Row price is "the price nobody pays" at municipal scale | Honest fixtures; Variations badge + tag filters keep cross-product views usable |
| Per-segment view ("everything for Zone North") | Table filter by zone/tag over price rows (flat records make this cheap) |

## 9. Next step

Run the **`superpowers:writing-plans`** skill against this spec to produce the implementation plan (task breakdown, file-by-file changes, fixture inventory, type-check gates via `npx tsc --noEmit`). Suggested build order: registry + fixtures → Products table changes → full-page product detail → flows (Quick create, Vary, Adjust) → Service provider prices module + details tab → Explain a price → settings pane.

## 10. Prototype variant verdict (2026-08-19)

Three interactive variants were built on `/commercial?variant=a|b|c` and captured on the throwaway branch `prototype/products-prices-variants` (commit 536c714 — not for merge):

- **A — Catalogue + detail page** (spec-literal, §4.2)
- **B — Inline price grid** (no navigation; price rows as the selection unit)
- **C — Split-view pricing desk** (price-list rail + persistent detail)

**Verdict (Fares): Variant A wins.** Two conditions attached to the verdict:

1. **The §4.1 placement rule is load-bearing, not optional** — anything configured once (company defaults, registries, surcharge rules, service provider performance parameters, the price-lists index) lives in **/settings → Commercial defaults**; anything adjusted repeatedly (prices, variations, bulk adjustments, indexation, negotiated deals) lives in **Commercial**. The prototype must demonstrate both surfaces.
2. **Existing UI primitives only** — the build uses the app's established components and visual language (shadcn/ui primitives, the BusinessWorkspace table/chrome patterns, existing dialog/sheet/detail-page precedents). No new visual styles, layouts, or component idioms.

**Follow-up (same day, after the refined prototype walkthrough):** two additions requested by Fares and built into the prototype:

1. **The prototype is the default Commercial surface in dev** — the sidebar's Commercial link (plain `/commercial`) renders the prototype in development builds; the old workspace stays reachable via `?module=…` (workspace-internal navigation) and production builds are unchanged. Real implication: the redesigned Products & Prices IS the Commercial landing surface, not a side-door variant.
2. **Service provider details gets a Prices tab** — previously deferred, now demonstrated: the service provider record page (Service providers workspace) carries a "Prices" tab rendering that service provider's PAY-lane rates (locked bid, indexed current fee, Apply index). This is the contract-first entry point from §8's bid-entry risk row and belongs in the real build order (§9) as part of "Service provider prices module + details tab".

**Follow-up (2026-08-20, after reviewing the refined prototype):** four revisions requested by Fares and built into the prototype:

1. **Explain a price is cut** — the sheet and every entry point (Products/Invoices headers, product detail, invoice-line amounts) are removed from the UI. The resolution engine itself stays: invoice line amounts are still computed from the live price rows, and the headless scenario harness still exercises §4.4. This walks back §4.5's launch points; if explainability returns it needs a new proposal.
2. **The Products table drops its explainer subtitle** and gains four attribute columns — **Container** (the linked rental container, when the product includes one), **Container type**, **Customer** (customers with a negotiated row on the product), **Waste fraction** — mirroring the live app's Products-tab columns (research §1). Products carry the first, second and fourth as catalogue attributes; Customer is derived from negotiated price rows.
3. **Settings gets a "Commercial" nav section** (dev-only, below Administration) with four categories: **Products** (read-only catalogue with the same attribute columns, linking to the Commercial workspace), **Zones**, **Service** (service levels), **Customer types**. The three registries moved out of the Commercial defaults pane into their own categories; Commercial defaults keeps company defaults, the Materials registry, surcharge rules, service provider performance, and the price-lists index.
4. Note the tension this introduces with §4.1's two-lane rule: a settings-side Products surface partially mirrors the Commercial workspace catalogue. The prototype keeps the settings copy read-only ("prices are managed in the Commercial workspace") to preserve the rule; the real build must decide whether the settings Products category is a registry view (as built) or a second management surface.

**Direction confirmed (2026-08-20):** Fares explicitly confirmed the Variant A direction. The §9 next step (writing-plans → implementation) is no longer gated on his verdict — only the plan itself still goes to him for review before execution.

**Implementation shipped (2026-08-20).** The plan derived from this spec (`docs/superpowers/plans/2026-08-20-products-prices-implementation`) is built, reviewed task-by-task, and cut over. Three decisions made during the build, recorded here because they resolve open questions above:

1. **Generic views only.** The Commercial workspace (products, price-rows, service-provider-prices modules) renders entirely through the standard `BusinessWorkspace` table/detail/dialog machinery — fact columns, the generic record detail sheet, `BusinessRecordFormDialog` for create/edit/adjust flows. The prototype's bespoke catalogue/detail/dialog/lane UI (`variant-a-catalogue.tsx`, `prototype-dialogs.tsx`, `prototype-shared.tsx`) was a build aid, not a component to ship, and was **not** ported. This is Fares's generic-views constraint honored by construction, not by exception.
2. **Settings → Commercial → Products is the product management surface**, resolving the tension in point 4 above in favor of "second management surface": creating or editing a product happens in Settings (born-priced — creating a product also creates its Everyone default price row in one step), not in the Commercial workspace. The Commercial workspace's Products module is the pricing view (rows, variations, adjustments); Settings is where a product's existence and its identity facts are authored. `components/settings/commercial-settings.tsx` carries this (`CommercialDefaultsExtras` for the read-mostly registries/surcharges/performance/price-lists index, `CommercialSectionPane` for the Products/Zones/Service/Customer-types categories).
3. **The workspace is relabeled "Price Engine."** Label-only — the sidebar and page copy read "Price Engine" wherever the workspace was previously labeled "Commercial" for pricing purposes; the `commercial` workspace id, its route (`/commercial`), and module ids are unchanged. This is the name that ships to replace the prototype's dev-only default-surface framing from the first follow-up above.

**Explain a price stays cut.** The 2026-08-20 (prototype) decision to remove Explain holds through the real build: there is no Explain entry point anywhere in the shipped UI. The §4.4 resolution engine that would have powered it did not disappear — it lives on as real production code in `lib/commercial/` (`price-model.ts`, `price-resolution.ts`) exercised headlessly by `scripts/price-resolution-harness.ts`, which drives §4.4's tie-break and precedence rules plus the fixture converters directly (19 checks — 15 engine scenarios + 4 registry — all passing). The engine is **not** wired to invoices: `resolvePrice` has no UI caller and the real `invoices` module is untouched fixtures. If explainability returns, per the prototype verdict, it needs a new proposal — the engine underneath it is ready.

The throwaway prototype folder (`components/wastehero/products-prices-prototype/`) is deleted as of the cutover commit; `app/commercial/page.tsx` no longer has a dev-only variant gate and unconditionally renders `WorkspacePageShell workspaceId="commercial"`.
