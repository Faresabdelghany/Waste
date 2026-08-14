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

Nearly every top-level route in `app/` (`/operate`, `/plan`, `/fleet`, `/customers`, `/resources`, `/commercial`, `/improve`, `/configure`, `/control-center`, `/route-studio`, plus aliases like `/routes` and `/tickets`) is a thin server component that renders `WorkspacePageShell` (`components/wastehero/workspace-page-shell.tsx`) with a `workspaceId` and optional `initialModuleId`. Navigation inside a workspace is driven by `?module=` and `?record=` search params; some pages redirect specific module params to dedicated routes (e.g. `/?module=driver-app` → `/driver`).

The shell machinery lives in `components/wastehero/`:
- `business-workspace.tsx` — the generic module list/table/detail rendering used by every workspace
- `business-record-form-dialog.tsx` — create/edit dialogs generated from form schemas
- `restricted-workspace-shell.tsx` — separate restricted shells for the driver, portal, contractor, and control-center personas (`/driver`, `/portal`, `/contractor-workspace`, `/control-center`)

### Data registries (`lib/data/`)

- `business-modules.ts` (~4200 lines) — the central registry: workspaces → modules → fixture records, plus fixture company/project/contractor IDs and per-record scoping (`FIXTURE_COMPANY_ID`, `FIXTURE_PROJECT_IDS`).
- `business-domain.ts` — machine-readable map of every UI surface to canonical business modules M01–M24 (owners, personas, dependencies, boundaries). Human-readable companion: `docs/BUSINESS_MODULE_MAP.md`. Consult these before moving features between workspaces — they define canonical ownership and known boundary corrections.
- `business-form-types.ts` + `business-form-schemas*.ts` — form field schemas per module, split across files by domain area.
- `projects.ts`, `clients.ts`, `project-details.ts`, `sidebar.ts` — fixture data for the legacy dashboard surfaces.

### Client-side state

`app/layout.tsx` wires the global providers: `BusinessRecordStoreProvider` (merges fixture records with user-created records per `workspace.module`, persisted to localStorage under `wastehero-business-records-v1`), `OrganizationStoreProvider` and `AssetManagementStoreProvider` (settings state), plus theme providers. All persistence is browser-local.

### Legacy vs canonical surfaces

The original portfolio dashboard still exists alongside the WasteHero prototype: `/projects/[id]`, `/clients`, `/tasks`, `/performance`, and components like `projects-content.tsx` and `project-timeline.tsx`. Per `docs/BUSINESS_MODULE_MAP.md` these are legacy — notably, the records under `/projects/:id` are Routes in domain terms, not Projects. In WasteHero language a "Project" is an operating scope (municipality, contract, region), never a route.

### Domain language

`CONTEXT.md` is the canonical glossary. Every term lists _Avoid_ synonyms — use the exact terms in UI copy and identifiers (e.g. Agreement vs Subscription, Route Scheme vs Route, Warehouse vs Depot, Ticket vs Alert).

### UI conventions

- shadcn/ui primitives (new-york style) in `components/ui/`; config in `components.json`; path alias `@/*`.
- Tailwind CSS v4 — there is no tailwind.config; theme tokens live in `app/globals.css`, the only live global stylesheet (`styles/globals.css` is unused; `styles/tiptap.css` is imported by the project description editor).
- Icons: lucide-react primarily; @phosphor-icons/react in some components.
- Theming: next-themes class-based dark mode plus `AppThemeProvider`/`ThemeBootstrapScript` with named theme presets in `lib/app-themes.ts` (persisted to localStorage).
