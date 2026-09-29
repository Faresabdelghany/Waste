@AGENTS.md

# apps/web

The Next.js App Router prototype (TypeScript, Tailwind CSS v4, shadcn/ui). Records are fixtures from `lib/data/` merged with browser storage, except in the modules switched onto the API.

## The workspace shell

- Most top-level routes in `app/` are thin server components that render `WorkspacePageShell` (`components/waste/workspace-page-shell.tsx`) with a `workspaceId`. Navigation inside a workspace is the `?module=` and `?record=` search params.
- `components/waste/business-workspace.tsx` renders every workspace's modules generically, and `business-record-form-dialog.tsx` builds the create and edit dialogs from the schemas in `lib/data/business-form-schemas*.ts`. The driver, portal, service-provider and control-center personas have restricted shells (`restricted-workspace-shell.tsx`).
- `lib/data/business-modules.ts` is the registry of workspaces, modules and fixture records. `lib/data/business-domain.ts` maps every surface to its canonical business module; consult it before moving a feature between workspaces.
- A `ProjectScope` is a project record's id or `"all"`; every scope question goes through `lib/data/project-scope.ts`.

## The record store and the API

- `components/waste/business-record-store.tsx` answers `getRecords` and `upsertRecord`. A module in `SERVER_MODULES` (`lib/api/records/modules.ts`) reads the API while a person is signed in against one; every other module reads fixtures plus the browser's bucket. To switch a module, add it there, with a mapping under `lib/api/records/` wherever the wire and the prototype's form disagree.
- A switched module shows the server's rows, or its fixtures until they arrive or when the load failed — never a mix with records made in the browser.
- `lib/api/client.ts` is the one way the web calls the API. The prototype's ids stay the web's handles; the server's id is kept beside the record in the module's `serverIds`.
- The browser calls `/waste-api/*` on its own origin, and `next.config.mjs` proxies it to `WASTE_API_ORIGIN`, since the API has no CORS yet. `NEXT_PUBLIC_WASTE_API_URL` turns the adapter on; the two `NEXT_PUBLIC_SUPABASE_*` variables turn on password sign-in at `/login` (see `.env.example`).

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

- shadcn/ui (new-york) lives in `components/ui/`, the Tailwind v4 theme tokens in `app/globals.css` (the one live global stylesheet), icons come from lucide-react.
- `/projects/[id]`, `/clients`, `/tasks` and `/performance` are the legacy portfolio dashboard; the "projects" there are Routes in domain terms.
- Unit tests are `lib/**/__tests__/*.test.ts` on `node:test`. `e2e/` sits outside this tsconfig and is checked by `pnpm typecheck:e2e`.
