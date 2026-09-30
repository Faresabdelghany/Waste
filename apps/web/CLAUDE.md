@AGENTS.md

# apps/web

The Next.js App Router prototype (TypeScript, Tailwind CSS v4, shadcn/ui). Records are fixtures from `lib/data/` merged with browser storage, except in the modules switched onto the API.

## The workspace shell

- Most top-level routes in `app/` are thin server components that render `WorkspacePageShell` (`components/waste/workspace-page-shell.tsx`) with a `workspaceId`. Navigation inside a workspace is the `?module=` and `?record=` search params.
- `components/waste/business-workspace.tsx` renders every workspace's modules generically, and `business-record-form-dialog.tsx` builds the create and edit dialogs from the schemas in `lib/data/business-form-schemas*.ts`. The citizen portal and the service-provider persona have restricted shells (`restricted-workspace-shell.tsx`); the driver's surface is the Driver App, below.
- `lib/data/business-modules.ts` is the registry of workspaces, modules and fixture records. `lib/data/business-domain.ts` maps every surface to its canonical business module; consult it before moving a feature between workspaces.
- A `ProjectScope` is a project record's id or `"all"`; every scope question goes through `lib/data/project-scope.ts`.

## The record store and the API

- `components/waste/business-record-store.tsx` answers `getRecords` and `upsertRecord`. A module in `SERVER_MODULES` (`lib/api/records/modules.ts`) reads the API while a person is signed in against one; every other module reads fixtures plus the browser's bucket. To switch a module, add it there, with a mapping under `lib/api/records/` wherever the wire and the prototype's form disagree.
- A switched module shows the server's rows, or its fixtures until they arrive or when the load failed — never a mix with records made in the browser.
- `lib/api/client.ts` is the one way the web calls the API. The prototype's ids stay the web's handles; the server's id is kept beside the record in the module's `serverIds`.
- A row's command (`POST /users/:id/deactivate`) is an entry in its adapter's `commands`, sent through the store's `sendCommand`; `upsertRecord` answers a switched module's write outcome, so a dialog can stay open on a refusal. Settings › Users & roles reads the organisation store in fixture mode only; on the Pilot it reads `configure.access` alone (`lib/data/users-roles.ts`) and, through `useServerModuleState`, shows nothing rather than the fixtures until the module is ready; `useModuleRecords` is that rule for a pane's own module, which Areas & Zones, Collection calendars, Holiday lists and Master data read through, and `whenSaved` is the one way a pane waits on a write's outcome. Master data (`configure.master`) is four adapters in one module (`lib/api/records/master-data.ts`); which kind a record is — its id prefix, then its typed `kind` — is `masterDataKindOf` (`lib/data/master-data.ts`), the rule the adapters own by and the pickers pointing at the module filter by; the pane's forms are its own, the registry's schema for the module stays disabled, and the pane is reached through `masterDataSettingsHref`. A planning area record carries the boundary version in force on the project's day as GeoJSON under `PLANNING_AREA_GEOMETRY_KEY` (`@waste/domain/map-planning/areas`), which the map draws over its container-derived outline; an upcoming or ended version lends the record its dates and id, not its geometry (`lib/api/records/planning.ts`).
- The browser calls `/waste-api/*` on its own origin, and `next.config.mjs` proxies it to `WASTE_API_ORIGIN`, since the API has no CORS yet. `NEXT_PUBLIC_WASTE_API_URL` turns the adapter on, and with it the Pilot's sign-in: every page but `/login` needs a session (`components/auth/sign-in-gate.tsx`), `/login` offers the password form alone (the two `NEXT_PUBLIC_SUPABASE_*` variables, see `.env.example`), a person lands where `GET /me` says (`Me.driver`: `/driver`, else `/operate`) and the sidebar's identity is `/me`'s. Without it the fixture picker, local development and e2e are as before.
- `lib/api/session.ts` holds the session's rules. Only the API's `urn:waste:problem:no-active-account` or a refresh Auth refuses ends a session; a 403 of `about:blank` is a permission refusal and leaves it alive.

## The Driver App

- `/driver` and `/driver/routes/[id]` are a surface of their own on the driver door, never a `SERVER_MODULES` entry: the screens in `components/waste/driver/`, the rules in `lib/driver/` — `driver-app.ts` is the controller (reads, taps, the drain), `command-queue.ts` the IndexedDB Command Queue, `route-view.ts` what a screen offers. Nothing is shown that the server has not answered: no local `decide`, no display cache.
- It imports the contracts as types only; a value it needs from them is spelled again and held equal by a test (`BATCH_LIMIT`).

## Persisted state and renames

- Every storage key is a constant in `lib/storage-keys.ts`, read through `readPersisted`, which carries a value over from a retired key.
- Persisted ids and hrefs go through `lib/data/legacy-ids.ts` (`migrateLegacyState`, `migrateLegacyId`, `migrateLegacyHref`). Retired names — Contractor, Contract area, the `wastehero` keys and ids — live only there, in `lib/storage-keys.ts`, in the redirects of `next.config.mjs` and in the stores' `LEGACY_*` maps. Keep those maps: they migrate state that browsers still hold.
- Two modules moved into Settings; resolve them through `PLANNING_AREAS_MODULE` (`lib/data/planning-areas.ts`) and `COLLECTION_CALENDARS_MODULE` (`lib/data/collection-calendars.ts`) rather than spelling the workspace and module.

## Map planning

- MapLibre's tile worker is served by `app/maplibre/[version]/[asset]/route.ts`, because Turbopack breaks its module-worker URL; keep `setWorkerUrl` pointed there. Camera moves jump instantly until a style has loaded.
- Maps are north-up and flat: the road overlay's transform assumes it, so rotation and pitch stay disabled.
- Roads come from the public OSRM demo server (no SLA, prototype only; the target is self-hosted Valhalla, ADR-0002) through `lib/map-planning/road-geometry-cache.ts`. E2E tests stub OSRM per test.
- The planning questions — what a selection holds, coverage, routes, scheme comparison — are answered by `@waste/domain/map-planning/*`. The domain cannot see the registry, so every call that places a record takes `FIXTURE_GAZETTEER` (`lib/data/street-gazetteer.ts`) as an argument.

## Next.js

- React Compiler is on; a `react-hooks/*` lint warning marks code the compiler skips.
- Cache Components is on: every `page.tsx` and the root layout export `instant = false`, and a component that reads `useSearchParams` sits under `<Suspense>`. Routes stay mounted across client navigations, so component state survives going back.

## UI and tests

- shadcn/ui (new-york) lives in `components/ui/`, the Tailwind v4 theme tokens in `app/globals.css` (the one live global stylesheet); icons come from `@phosphor-icons/react` across the workspace and from lucide-react in the shadcn primitives and the account menu.
- `/projects/[id]`, `/clients`, `/tasks` and `/performance` are the legacy portfolio dashboard; the "projects" there are Routes in domain terms.
- Unit tests are `lib/**/__tests__/*.test.ts` on `node:test`. `e2e/` sits outside this tsconfig and is checked by `pnpm typecheck:e2e`.
