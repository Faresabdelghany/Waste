<h1 align="center"> Operations Platform · UI Prototype</h1>

<p align="center">
  A multi-workspace prototype of the operations platform for waste & recycling logistics —
  covering daily operations, route planning, fleet, customers, assets, commercial, and analytics.
</p>

---

## Overview

This repository is a **UI-only prototype** of the  operations platform, built with:

- **Next.js (App Router)**
- **TypeScript**
- **Tailwind CSS v4**
- **shadcn/ui + Radix UI primitives**

There is no backend, API, or real authentication. All data is fixture data in `lib/data/`, merged with user-created records in client-side stores persisted to `localStorage`. The goal is to explore and validate the product's information architecture, workflows, and UI patterns before backend integration.

## Workspaces

The platform is organized into role- and domain-oriented workspaces, each rendered through a shared workspace shell:

| Route | Workspace |
| --- | --- |
| `/operate` | Daily operations — collections, tickets, exceptions |
| `/plan` | Planning — route schemes, scheduling |
| `/route-studio` | Route Studio — route design and optimization |
| `/fleet` | Fleet — vehicles, maintenance, compliance |
| `/customers` | Customers — properties, agreements, service requests |
| `/resources` | Resources — containers, assets, warehouses, staff |
| `/commercial` | Commercial — pricing, invoicing, contracts |
| `/service-providers` | Service providers — external haulers, awarded service areas, activity |
| `/improve` | Improve — analytics, performance, quality |
| `/configure` | Configure — organization and platform settings |
| `/control-center` | Control Center — live dispatch and monitoring |

Restricted persona surfaces sit alongside the internal workspaces:

- `/driver` — driver app experience
- `/portal` — customer portal
- `/service-provider-workspace` — external service provider workspace

## Architecture

- `app/` — thin server-component routes; most render `WorkspacePageShell` with a `workspaceId`. In-workspace navigation is driven by `?module=` and `?record=` search params.
- `components/wastehero/` — the workspace shell machinery:
  - `business-workspace.tsx` — generic module list/table/detail rendering used by every workspace
  - `business-record-form-dialog.tsx` — create/edit dialogs generated from form schemas
  - `restricted-workspace-shell.tsx` — shells for the driver, portal, service provider, and control-center personas
- `lib/data/` — the data registries:
  - `business-modules.ts` — central registry: workspaces → modules → fixture records
  - `business-domain.ts` — machine-readable map of every UI surface to canonical business modules M01–M24 (owners, personas, dependencies, boundaries)
  - `business-form-types.ts` + `business-form-schemas*.ts` — per-module form field schemas
  - `legacy-ids.ts` — old → new id maps and `migrateLegacy*` helpers that keep browser state and bookmarks from before the 2026-09-02 terminology rename working (see `CLAUDE.md`)
- `components/ui/` — shadcn/ui primitives (new-york style); theme tokens live in `app/globals.css` (Tailwind v4, no config file).

### Domain language

`CONTEXT.md` is the canonical glossary. Every term lists synonyms to avoid — use the exact terms in UI copy and identifiers (e.g. **Agreement** not Subscription, **Route Scheme** not Route, **Warehouse** not Depot, **Ticket** not Alert). In WasteHero language a **Project** is an operating scope (municipality, contract, region) — never a route.

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm

### Install & run

```bash
pnpm install
pnpm dev
```

The app will be available at `http://localhost:3000`.

### Build & type-check

```bash
pnpm build
pnpm start
npx tsc --noEmit   # type errors are not caught by the build — run tsc explicitly
```

## Tech Stack

- **Framework**: Next.js (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4
- **UI**: shadcn/ui, Radix UI
- **Icons**: Lucide, Phosphor Icons
- **State**: React context stores persisted to `localStorage` (records, organization settings, themes)
