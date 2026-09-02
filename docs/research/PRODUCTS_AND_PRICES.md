# WasteHero — Settings → Products & prices (research notes)

Explored live on `app-development.wastehero.io` (2026-08-19), impersonating company **Provas2**
(projects: *Provas*, *Provas Sommerhusområde*). Screenshots in this folder (`pp-*.png`).

> **Terminology note (2026-09-02).** The live product labels these entities **Contractors**,
> **Contractor prices** and **Contract areas**. This prototype renamed them to **Service providers**,
> **Service provider prices** and **Service areas** on 2026-09-02 (see `CONTEXT.md`), so every
> "service provider" / "service area" in the prose below corresponds to the live product's
> "contractor" / "contract area". Quoted UI labels, route paths, column headers and wizard step
> names are reproduced exactly as the live product shows them (Contractor …); the screenshot
> `pp-service-provider-prices.png` is the live Contractor prices tab under its renamed file name.
> The **Domain model (for implementation)** sketch at the end is the one exception: it is written
> in this prototype's vocabulary (`ServiceProviderPrice`, `scope company|service-provider|area`),
> whereas the live entity is `HaulerPriceDef` and the live scope enum reads Company/Contractor/Area,
> as the Contractor performance section reports.

## What it is

The **product catalogue and pricing engine** of the platform: "Set up what you offer and what it
costs, for customers and contractors." It is the *new* pricing module (route prefix
`/app/settings/company/:id/product-management/…`); companies without the feature flag are
redirected to the older **Legacy pricing** module (pricing categories Containers/Services/Recurring
plus "Agreement template"), which this module replaces.

Backend: its own REST microservice (`https://dev-platform-api.wastehero.io/product/api/v1/…`,
ULID entity ids, audit-logged) — unlike most of the app, which is GraphQL. Service provider prices are
the exception: they resolve to GraphQL global ids (`HaulerPriceDef:<n>`).

## Business goal

1. **Catalogue** — define every sellable thing once (a bin collection service, a recurring
   subscription/rental charge, a one-off extra) with the operational attributes the platform
   needs (waste fraction, container type, pickup schedule, property type).
2. **Customer pricing** — attach prices to those products through **price lists**, where the same
   product can cost different amounts by zone, customer type, service responsibility, property
   type etc. A deterministic **price-determination engine** resolves the right price at
   order/agreement time.
3. **Service provider pricing** — record what the company *pays* haulers per agreement/service area,
   with itemised components, indexation, metered lines, and performance-based bonus/penalty
   settlement.
4. **Governance** — everything effective-dated, schedulable, previewable, and fully audited.

Direction concept ties it together: products are **Outgoing** (sold to customers), **Incoming**
(bought/paid to service providers) or **Transfer**.

## Information architecture

Three top tabs: **Products | Prices | Setup**.

```
/product-management
  /products                 Products tab (?type=All|Containers|Recurring|Additional)
  /products/new             4-step create wizard
  /products/:ulid           Product detail (Overview | Extras)
  /prices                   Prices tab — Customer prices (flat view of all price rows)
  /prices/contractor        Prices tab — Contractor prices
  /price-lists              Price list index (breadcrumbed under Setup)
  /price-lists/new          Create price list
  /price-lists/:ulid        Price list detail (?highlightRow=...)
  /price-adjustments        Contractor bulk adjust / index change
  /contractor-prices/:gid   Contractor price 5-step wizard (edit/create)
  /categories               Setup → Building blocks (product templates)
  /categories/:ulid         Template detail (schema)
  /compensation-models      Setup → Contractor performance
  /compensation-models/new  New bonus & penalty model
  /price-determination-playground   Setup → Price check (?traceProduct=...)
  /audit-logs               Setup → History
  /legacy-pricing/*         Old module (no feature flag)
```

---

## 1. Products tab

Sub-tabs = product templates types: **All types | Containers | Recurring | Additional services**.

Table columns per sub-tab:
- **Containers**: Internal name · Waste fraction · Container type · Pickup setting · Base fee
  (e.g. "€640 per year · incl. VAT €800 (25%)") · Status
- **Recurring**: Internal name · Property type · Base fee · Status
- **Additional services**: Internal name · Internal code · Price · Status
- **All types**: Internal name · Product template · Base fee · Status

Toolbar: saved filters (star), filter panel (dimensions: Status, Product template, Waste fraction,
Container type, Pickup setting, Property type, **Direction** = Incoming/Outgoing/Transfer;
"Save as new filter"), search, Export (enabled with selection), **Import**, **+ Product**, column
picker. Row actions: **View** · ⋮ (**Delete** only).

### Product import (xlsx upsert)
Keyed on `product_code` (existing code updates, unknown creates). Columns: Product Code*, Name*,
Status (Active/Inactive, empty = unchanged), **Category*** (must match product category name),
Waste Fraction, Container Type, Pickup Setting, Property Type, Price, Unit (must match a pricing
unit name). "Download template" and "Download example" provided.

### Create wizard (`/products/new`) — 4 steps
1. **What are you selling?** Three cards → Container Collection ("a bin or container with
   collection — waste type, size and pickup schedule"), Recurring Services ("a charge billed on a
   schedule — like a subscription or rental fee"), Additional Services ("an extra charged
   alongside another product — like an additional emptying"). The choice picks a *product
   template* and "decides which details the product needs".
2. **Details** (container): Internal name; Waste Fraction (multi-select, inline "+ Create new");
   Container Type (**dependent — disabled until fraction chosen, options filtered by fraction**,
   inline create); Pickup Setting (inline create); Property Type (optional). Recurring: just
   Internal name + Property Type (optional). Note: "Optional fields (internal code, invoice name,
   portal visibility…) can be added on the product page afterwards."
3. **Price**: Base fee (€ *per year*); Invoice name + Invoice code (become **required once a base
   fee is set**); VAT Rate (named rates, e.g. "Standard rate (Denmark)" 25%); live computed
   "Price incl. VAT: €125 (25%)". Then a separate **Pickup price** block: "Charged for each
   emptying — separate from the base fee. It lives in the price list, where it can vary by zone,
   customer type and more." (optional price per pickup + its own invoice name/code). Info alert:
   "No pickup price yet — you can add prices in a price list at any time." Recurring variant:
   optional Price per unit (e.g. per Piece), invoice fields, VAT.
4. **Review**: summary table + "Everything here can be changed later — the product page and the
   price list stay fully editable."

### Product detail (`/products/:ulid`)
Header: name, Active/Inactive badge, template badge, `ID: <internal code>`, **Edit all**.
Tabs **Overview | Extras**.

Overview sections (each with pencil-edit):
- **Basic information**: Internal name, Internal code, Product template, Product Group.
- **Container**: Container Type, Pickup Setting, Default Weight *(derived)*, Volume Unit
  *(derived)*, Waste Fraction, Property Type, Billing Frequency.
- **Prices in price lists**: which lists price this product ("Not priced in: test, 240L, …").
- Sidebar **Base fee** card: amount + period, VAT rate, price incl. VAT, invoice name/code,
  "Edit pricing".
- **Compliance & portal** (collapsible): Transfer Document Obligation (Y/N), Weighbridge
  Assignment (Y/N), Portal Visibility (Y/N).
- Footer: "Pickup prices vary by zone and customer type — they live in the price lists." →
  **Open Price Lists**.

**Extras tab** — "charged on top of the base price", three linked groups, each with + add:
- **Materials** ("locks, liners, parts…"): Name, Price, Unit of measure (configurable units:
  Liter, Piece…), "Included in Total" toggle, optional template quick-fill.
- **Additional services** ("link extra services like an additional emptying") — links catalogue
  Additional products.
- **Service levels** ("offer express or same-day tiers") — links Setup service levels.

---

## 2. Prices tab

### Customer prices (`/prices`)
Flat, cross-list view of every **price row**: Product · Price list (link + "Negotiated" badge) ·
Price · **Applies to** ("Everything" when unconditioned) · View (deep-links
`/price-lists/:id?highlightRow=<rowUlid>`). Filter dimensions: Price list, **Price list status**
(Active/Scheduled/Draft/Inactive — default filter = Active only), Negotiated.

### Price lists (`/price-lists`, breadcrumb "Setup / Price lists")
Columns: Name · Description · Products (count) · Effective from · Last modified · Status.
Row actions: View · ⋮ Edit / Delete. Create: Name, Description, **Effective From (optional —
"Leave blank to create as Draft and activate manually")**. Edit adds Status (Draft/Active/
Inactive); *Scheduled* is derived from a future effective date. **Negotiated** lists exist (e.g.
customer-negotiated deals) — their rows don't resolve as the general price (price-check on a
product priced *only* in a negotiated list returns `product_not_priced`).

### Price list detail (`/price-lists/:ulid`)
Header: name + status + warning: **"Same-level zone overlaps warn at save; a forced save uses the
documented tie-break and is logged."**
Toolbar: saved filters, filter (Product template, Type), search, Collapse all, **Bulk adjust**
(needs selection), **Import**, **Add price**, **New product**, columns.
Table grouped by product (expandable; product name links to product page, "N price(s)" count):
price rows show Waste fraction/Container type conditions ("Any"), Price ("€15 incl. VAT —"),
Last changed. Row actions: **Edit** · ⋮ **Test this row** (→ price check playground with
`?traceProduct=`) / **Schedule** / **Delete**.

**Price row model** (Add/Edit dialog — "Price an existing product in this list — leave a
condition as Any for it to apply to everyone"): Product, Invoice Display Name, Invoice Code,
Price (€) + **Additional settings** (all optional, default "Any"): Customer Type
(INDIVIDUAL/BUSINESS), Zone (from Settings → Map layers & zones), Service Responsibility,
Waste Fraction, Container Type, Pickup Setting, Property Type, VAT Rate.

**Schedule a price change** (per row): New price, Effective from ("Local time. Past dates are not
allowed."), optional "Revert to a price after this date".

**Bulk adjust prices** (selected rows): Increase by % / Decrease by % / Set to fixed price /
Multiply by factor + optional Schedule: "Apply on" (activates on date for every selected row) and
"Revert to original price on" (auto-revert). Applies to N prices.

**Price import** (xlsx, per price list): Price List* (by name), Product Code* ("together with the
condition columns this identifies the row to update; an unmatched combination creates a new price
row"), Price*; condition columns Customer Type / Zone / Service Responsibility / Waste Fraction
("multi-fraction set conditions cannot be imported") / Container Type / Pickup Setting / Property
Type (empty = all); VAT Rate ("required (non-zero) when the product's waste fraction is flagged
'must include VAT'"); Descriptor (invoice display name override); Invoice Code; **Minimum Charge**
("non-negative decimal line minimum (HAUL-209)").

### Price determination (Price check playground)
"Simulate the initial price for a product without creating an order. Simulations are not
persisted." Inputs: Product, Customer type (Individual/Business), Zone (opt), Service
responsibility (opt), Quantity, Service level code (opt) → Run simulation → price breakdown.

API: `POST /product/api/v1/price-determination/preview`
`{"product_id": ULID, "customer_type": "INDIVIDUAL"|"BUSINESS", "quantity": n,
"bill_of_materials": []}` →
```json
{"unit_price":"12.50","quantity":1,"total":"12.50",
 "lines":[
   {"label":"Base — best-match row","value":"12.50",
    "context":{"type":"base_match","row_id":"…","matched_conditions":[],"match_score":0,"unit_price":"12.50"}},
   {"label":"Service level (none)","value":"0.00",
    "context":{"type":"service_level","code":null,"resolution_source":"zero"}}],
 "warnings":[],"skips":[]}
```
Mechanics: **best-match row** — rows are scored by how many conditions match (`match_score`,
more specific wins); service-level surcharge and bill-of-materials lines are added on top.
Error when nothing resolves: 422 `product.price_determination.product_not_priced`.

### Contractor prices (`/prices/contractor`) — "Service provider prices" in this prototype
What the company **pays** haulers. Columns: Contractor (link) · Agreement (= the product) ·
Area (service area link, e.g. "Haderslev North") · Period (validity range) · **Base fee** (bid) ·
**Current fee** (after indexation) · **Components** (e.g. "Base lift rate: 680,00 € · Fuel index
uplift: 9.5%", "Rural distance supplement: 95,00 €", "Seasonal uplift (Apr–Oct): 9.3%") · Status.
Toolbar: **Adjust prices**, Action → **+ Contractor price**. Row: Edit · ⋮.

**Contractor price wizard** (5 steps — `/contractor-prices/:gid`):
1. *Contractor* (immutable on edit — "create a new price to move an agreement").
2. *Agreement* — pick a catalogue product; already-priced ones grouped by service area with
   "Bid X € · Current Y €", the rest listed as "Not priced for this contractor yet".
3. *Scope & price* — Area, Period (start/end), Fee, Label, optional **Specific customer /
   property** ("Leave empty for the normal area price. Pick a property to set a deviating
   contractor price that applies only to that customer.").
4. *Components* —
   - Fee components: "Optional named lines that itemise the fee: flat amounts in money, percent
     lines as % of the flat sum. Saving replaces the whole list; order on screen is the stored
     order."
   - **Metered lines**: "paid per measured quantity in each settlement period — rate × what the
     period actually measured. They join the settlement totals, not the per-stop fee, and save
     immediately, independent of this wizard." Auto-counted computations: `per_round`,
     `per_emptying`; manual-quantity bases (per tonne, per hour, haul distance, reversing
     distance) are greyed out until data flows.
   - **Measured quantities**: office types monthly figures per service area (tonnes, hours, haul
     km, reversing km) — "no automatic sensor/weighbridge feed"; metered lines pay
     rate × entered figure.
5. *Review*.

**Adjust prices** (`/price-adjustments`): two modes —
- *Percentage or fixed amount*: Percent/Fixed, value ("3 raises fees by 3%; -3 lowers"),
  **Apply on** ("The old price row is ended the day before; the new fee applies from this date"),
  optional **Revert to original price on**, **Apply to pricing level**: Parent areas / Carve-outs /
  Both ("Parent = top-level contract areas. Carve-outs = nested areas that override their
  parent."), optional limits to service area / agreements, Note (shown in history). Preview
  table before apply.
- *Index change* (CPI/fuel): Index change %, **Computed from: Base price (original bid) or
  Current price ("compounds earlier changes")**, same apply/revert/scope fields. "The bid price
  is the original contract price — it stays visible here and never changes; index adjustments
  only move the current fee." Preview: Agreement · Area · Bid price · Current fee · Valid.

---

## 3. Setup tab

Hub: "Configuration you set up once. Products and prices work without most of this — add it when
you need it." Five cards:

### Building blocks (`/categories`)
Tabs: **Product templates | Materials | Service Levels | Surcharge Rules**.
- *Product templates*: Name · Type (Container/Recurring/Additional) · Status · Products count ·
  Schema fields count. Template detail = **schema configurator**: grouped fields, each
  System-required or optional-toggleable — Container Properties (Container Type*, Pickup
  Setting*, Default Weight*, Volume Unit*, Dimensions), Billing (Billing Frequency*), Waste
  Classification (Waste Fraction*, Hazardous Waste Properties), Location & Logistics (Origin
  Location, Storage Location, Direction), Applicability (Property Type), Optional (Load
  Inspection). The wizard's three cards map to template *types*; multiple template instances can
  exist per type.
- *Materials*: Name · Price · Unit · Included in total · Status (BOM items linked to products).
- *Service Levels*: Name · Code · Description · Surcharge · Timeframe (e.g. Emergency 1 Day,
  Same-day 1 Day, Express 3 Days, Standard) · Status.
- *Surcharge Rules* ("New timing rule"): Name, Trigger reason (holiday | weekend), Recurrence
  (annually | monthly), Surcharge type (percentage | fixed), value, Month + Start/End day window,
  Active. "When multiple rules overlap on the same date, only the highest surcharge is applied."

### Price lists
Same index as above ("The lists themselves: status, validity window, minimum charge and
customer-override inheritance. Prices live on the Prices tab.").

### Contractor performance (`/compensation-models`) — no module in this prototype; its counterpart is the read-only "Service provider performance" card under Settings → Administration → Commercial defaults
Tabs: **Bonus & penalty | Exception pay effects**.
- *Bonus & penalty models*: Name · Contractor · Contract area · Type (Bonus only / Bonus and
  penalty) · Scope (Company/Contractor/Area — "in settlement the most specific matching model
  wins (area → contractor → company)") · Structure summary · Valid from/to · Status.
  Formula (from the form): "Each month the area's complaint share (complaints that affect pay ÷
  completed tasks) is turned into a pay coefficient: **coefficient = 1 + a × (b − complaint
  share)**. Fewer complaints than the tolerated share (b) earns a bonus; more earns a penalty (if
  the structure allows one). If reliability is below the target, no bonus is paid. The adjustment
  never exceeds the cap." Fields: Complaint weighting (a), Tolerated complaint share (b),
  Reliability target % (optional gate), Max adjustment % (cap), Active from/to.
- *Exception pay effects*: per exception type (Overfilled, Access blocked, Wrong orientation, Too
  far from road, Contaminated, Frozen/jammed, Not presented, Roadworks/road closed, …):
  **Pay effect** = Payable in full / Not payable / Payable at a reduced rate; **Reliability
  effect** = Counts against reliability / Excused; Effective from ("you cannot back-date");
  scheduled changes shown; "Scheduling an effect does not change already-settled periods."

### Price check
The simulator described above.

### History (`/audit-logs`)
"Every change to products and prices — who changed what, and when. Showing Product & Pricing
changes only; these also appear in System history." Columns: Timestamp · Entity type · Entity ID
(ULID + copy) · Entity name · Action (CREATED/UPDATED/…) · Changed by · Changes ("5 field(s)
changed", expandable to per-field `old → new` diffs).

---

## Domain model (for implementation)

Sketched in this prototype's vocabulary — see the terminology note at the top for the live
product's names.

```
ProductTemplate (type: container|recurring|additional; field schema, sys-required + optional)
  └─ Product (internal name/code, status, direction, waste fraction(s), container type,
              pickup setting, property type, billing frequency, base fee + VAT + invoice
              name/code, compliance flags, portal visibility)
       ├─ Extras: Materials (BOM), linked Additional services, Service levels
       └─ PriceRow (in a PriceList; price, invoice overrides, minimum charge,
                    conditions: customer type, zone, service responsibility, waste fraction,
                    container type, pickup setting, property type, VAT override;
                    schedulable: effective/revert dates)
PriceList (name, description, status draft|scheduled|active|inactive, effective-from,
           negotiated flag) — zone-overlap tie-break, bulk adjust, xlsx import
PriceDetermination: best-match scoring over condition columns → base line + service-level
           + surcharge + BOM lines; preview API, warnings/skips
ServiceProviderPrice / HaulerPriceDef (service provider, agreement=product, service area (parent or
           carve-out), period, bid fee vs current fee, named components flat|percent,
           metered lines per_round|per_emptying|manual bases, monthly measured quantities)
CompensationModel (scope company|service-provider|area, bonus/penalty coefficient formula, caps)
ExceptionPayEffect (per exception type, pay + reliability effect, effective-dated)
AuditLog (every entity, field diffs)
```

Cross-module dependencies: Zones come from Settings → Map layers & zones; waste fractions,
container types, pickup settings, property types from Asset management; VAT rates and pricing
units are named per-account lists; customers/properties and agreements consume the catalogue
(negotiated lists, specific-property service provider prices); Invoicing consumes invoice names/codes
and resolved prices; service provider settlement consumes components, metered lines, bonus models and
exception effects.
