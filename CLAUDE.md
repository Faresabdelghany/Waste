# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A UI-only prototype of the WasteHero operations platform (waste/recycling logistics), built with Next.js App Router, TypeScript, Tailwind CSS v4, and shadcn/ui. It started as a small portfolio "project dashboard" template (see README.md) and has grown into a full multi-workspace prototype. There is no backend, API, or real auth — all data is fixture data in `lib/data/` plus client-side stores persisted to localStorage.

## Commands

- `pnpm dev` — dev server at http://localhost:3000
- `pnpm build` / `pnpm start` — production build / serve
- `npx tsc --noEmit` — type check. `next.config.mjs` sets `typescript.ignoreBuildErrors: true`, so `pnpm build` does NOT catch type errors; run tsc explicitly.
- `pnpm lint` is defined (`eslint .`) but eslint is not installed, so it currently fails.
- There is no test suite.

pnpm is the package manager (pnpm-lock.yaml). If the volta pnpm shim fails ("Could not find executable"), `npm run <script>` works against the existing node_modules.

## Architecture

### Workspace shell — the core pattern

Nearly every top-level route in `app/` (`/operate`, `/plan`, `/fleet`, `/customers`, `/resources`, `/commercial`, `/improve`, `/configure`, `/control-center`, `/route-studio`, `/service-providers`, plus aliases like `/routes` and `/tickets`) is a thin server component that renders `WorkspacePageShell` (`components/wastehero/workspace-page-shell.tsx`) with a `workspaceId` and optional `initialModuleId`. Navigation inside a workspace is driven by `?module=` and `?record=` search params; some pages redirect specific module params to dedicated routes (e.g. `/?module=driver-app` → `/driver`).

The shell machinery lives in `components/wastehero/`:
- `business-workspace.tsx` — the generic module list/table/detail rendering used by every workspace
- `business-record-form-dialog.tsx` — create/edit dialogs generated from form schemas
- `restricted-workspace-shell.tsx` — separate restricted shells for the driver, portal, service provider, and control-center personas (`/driver`, `/portal`, `/service-provider-workspace`, `/control-center`)

### Data registries (`lib/data/`)

- `business-modules.ts` (~4200 lines) — the central registry: workspaces → modules → fixture records, plus the fixture company, project, and service provider IDs used for per-record scoping (`FIXTURE_COMPANY_ID`, `FIXTURE_PROJECT_IDS`, `FIXTURE_SERVICE_PROVIDER_IDS`).
- `business-domain.ts` — machine-readable map of every UI surface to canonical business modules M01–M24 (owners, personas, dependencies, boundaries). Human-readable companion: `docs/BUSINESS_MODULE_MAP.md`. Consult these before moving features between workspaces — they define canonical ownership and known boundary corrections. `settingsModuleDomains` lists the modules that keep real business records but are managed from Settings (registered under the `configure` workspace, e.g. `configure.areas` — Areas & Zones, moved from Plan 2026-09-03); the schema registry's lockstep gate counts their keys as expected, and `lib/data/planning-areas.ts` is the only place that knows where planning areas live.
- `business-form-types.ts` + `business-form-schemas*.ts` — form field schemas per module, split across files by domain area.
- `legacy-ids.ts` — old → new id maps and `migrateLegacy*` helpers from the 2026-09-02 terminology rename plus the 2026-09-03 Areas & Zones move (`plan.areas` → `configure.areas`; see Client-side state below). The only place the retired ids are defined; the stores import it and carry only their own `LEGACY_*` display-string maps and legacy shape guards (the full list of sanctioned exceptions is under Client-side state).
- `projects.ts`, `clients.ts`, `project-details.ts`, `sidebar.ts` — fixture data for the legacy dashboard surfaces.

### Client-side state

`app/layout.tsx` wires the global providers: `BusinessRecordStoreProvider` (merges fixture records with user-created records per `workspace.module`, persisted to localStorage under `wastehero-business-records-v1`), `OrganizationStoreProvider` and `AssetManagementStoreProvider` (settings state), plus theme providers. All persistence is browser-local.

**Terminology rename (2026-09-02): Contractor → Service provider, Contract area → Service area.** The rename changed the workspace id (`contractors` → `service-providers`), module ids (`contract-areas` → `service-areas`, `contractor-workspace` → `service-provider-workspace`, `contractor-prices` → `service-provider-prices`), record-id prefixes, enum literals, and routes (`/contractors` → `/service-providers`, `/contractor-workspace/*` → `/service-provider-workspace/*`). Fixtures and code use the new ids only, but browser-local state and bookmarks written before the rename still carry the old ones, so: stores that persist ids must run loaded state through `migrateLegacyState` (or `migrateLegacyRecordBuckets` for record buckets) from `lib/data/legacy-ids.ts`; `business-workspace.tsx` normalises `?module=`/`?record=` params through `migrateLegacyModuleId`/`migrateLegacyId`; and `next.config.mjs` redirects the old routes. Do not reintroduce the old terms anywhere else — the only sanctioned exceptions are: `lib/data/legacy-ids.ts` (the sole definition of the retired ids) and its harness `scripts/legacy-ids-harness.ts`; the redirect sources in `next.config.mjs`; the store-local `LEGACY_*` maps and shape guards that feed the migrate helpers (`LEGACY_ROLE_NAMES`/`LEGACY_ROLE_SCOPES` in `components/settings/organization-store.tsx`, `LEGACY_SCOPE_KEYS` in `components/wastehero/active-routes-store.tsx`, `LEGACY_RECORD_KEY_RENAMES` in `components/wastehero/business-record-store.tsx`); the legacy `wastehero-contractor-active-routes-v1` storage key that `active-routes-store.tsx` keeps for backward-compatible reads; and explicit historical notes that say the term was renamed, including the verbatim live-product labels quoted in `docs/research/PRODUCTS_AND_PRICES.md` under its terminology note. Do not strip those maps — the stores need them to migrate persisted state.

**Areas & Zones move (2026-09-03, D37 in `docs/new-changes/DECISIONS.md`): `plan.areas` → `configure.areas`.** The module left the Plan workspace for Settings → Operations → Areas & Zones; record ids did not change. Persisted state follows through the same `lib/data/legacy-ids.ts` seam: the `LEGACY_MODULE_KEYS` entry moves the record-store bucket and role-access keys, `migrateLegacyState` rewrites stored `relationRefs` whose `workspaceId`/`moduleId` pair names the old home, `hasLegacyIds` detects both shapes, and `migrateLegacyHref` sends `/plan?module=areas[&record=…]` to `/settings?pane=areas[&record=…]` (`app/plan/page.tsx` redirects server-side). Never hard-code the pair again — resolve it through `PLANNING_AREAS_MODULE` in `lib/data/planning-areas.ts`.

### Legacy vs canonical surfaces

The original portfolio dashboard still exists alongside the WasteHero prototype: `/projects/[id]`, `/clients`, `/tasks`, `/performance`, and components like `projects-content.tsx` and `project-timeline.tsx`. Per `docs/BUSINESS_MODULE_MAP.md` these are legacy — notably, the records under `/projects/:id` are Routes in domain terms, not Projects. In WasteHero language a "Project" is an operating scope (municipality, contract, region), never a route.

### Domain language

`CONTEXT.md` is the canonical glossary. Every term lists _Avoid_ synonyms — use the exact terms in UI copy and identifiers (e.g. Agreement vs Subscription, Route Scheme vs Route, Warehouse vs Depot, Ticket vs Alert).

### UI conventions

- shadcn/ui primitives (new-york style) in `components/ui/`; config in `components.json`; path alias `@/*`.
- Tailwind CSS v4 — there is no tailwind.config; theme tokens live in `app/globals.css`, the only live global stylesheet (`styles/globals.css` is unused; `styles/tiptap.css` is imported by the project description editor).
- Icons: lucide-react primarily; @phosphor-icons/react in some components.
- Theming: next-themes class-based dark mode plus `AppThemeProvider`/`ThemeBootstrapScript` with named theme presets in `lib/app-themes.ts` (persisted to localStorage).
