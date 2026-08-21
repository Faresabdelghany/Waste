"use client"

import Link from "next/link"
import { useMemo, type ComponentType } from "react"
import {
  CaretRight,
  MapPin,
  Path,
  Ticket as TicketIcon,
  Truck,
} from "@phosphor-icons/react/dist/ssr"

import { Badge } from "@/components/ui/badge"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { ProgressCircle } from "@/components/progress-circle"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import { statusClasses } from "@/components/wastehero/business-record-views"
import {
  FIXTURE_CONTRACTOR_IDS,
  getWorkspaceDefinition,
  type BusinessRecord,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import { contractorActiveRoutes } from "@/lib/data/sidebar"
import { cn } from "@/lib/utils"

const CONTRACTOR_ID = FIXTURE_CONTRACTOR_IDS.nordren

const CLOSED_TICKET_STATUSES = new Set([
  "completed",
  "resolved",
  "closed",
  "rejected",
])

const routeProgressById = new Map(
  contractorActiveRoutes.map((route) => [route.id, route]),
)

function KpiItem({
  label,
  value,
  helper,
  tone,
  icon: Icon,
}: {
  label: string
  value: string
  helper: string
  tone: "positive" | "warning" | "neutral"
  icon: ComponentType<{ className?: string }>
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-500"
      : tone === "warning"
        ? "text-amber-500"
        : "text-muted-foreground"

  return (
    <div className="relative min-w-0 px-4 py-4 xl:px-5">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <Icon className={cn("h-4 w-4 shrink-0", toneClass)} />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{helper}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        statusClasses(status),
      )}
    >
      {status}
    </Badge>
  )
}

function PanelHeader({ title, helper }: { title: string; helper: string }) {
  return (
    <div className="border-b border-border/70 px-4 py-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{helper}</p>
    </div>
  )
}

function parseStops(value: string): number {
  const match = value.match(/(\d+)\s*stops?/)
  return match ? Number(match[1]) : 0
}

export function ContractorDashboard() {
  const { getRecords } = useBusinessRecordStore()

  const contractorRecords = (workspaceId: WorkspaceId, moduleId: string) => {
    const workspace = getWorkspaceDefinition(workspaceId)
    const module = workspace.modules.find(
      (candidate) => candidate.id === moduleId,
    )
    if (!module) return [] as BusinessRecord[]
    return getRecords(workspaceId, moduleId, module.records).filter(
      (record) => record.contractorId === CONTRACTOR_ID,
    )
  }

  // Live store reads: records raised or invited from the restricted pages
  // count here on the next render, exactly as they appear on those pages.
  const routes = contractorRecords("route-studio", "routes")
  const tickets = contractorRecords("operate", "tickets")
  const vehicles = contractorRecords("fleet", "vehicles")
  const drivers = contractorRecords("fleet", "drivers")

  const activeRouteCount = routes.filter(
    (record) => record.status.toLowerCase() === "active",
  ).length
  const plannedStops = routes.reduce(
    (sum, record) => sum + parseStops(record.value),
    0,
  )
  const openTickets = useMemo(
    () =>
      tickets.filter(
        (record) => !CLOSED_TICKET_STATUSES.has(record.status.toLowerCase()),
      ),
    [tickets],
  )

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger className="h-8 w-8 rounded-lg hover:bg-accent text-muted-foreground" />
          <div className="min-w-0">
            <Breadcrumbs items={[{ label: "Dashboard" }]} />
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              NordRen ApS · Contract area CA-Ø-2
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span>Fresh 2 min ago</span>
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <section className="grid border-b border-border/70 sm:grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-border/70">
          {[
            {
              label: "Routes today",
              value: String(routes.length),
              helper: `${activeRouteCount} active · ${routes.length - activeRouteCount} planned`,
              tone: "positive" as const,
              icon: Path,
            },
            {
              label: "Planned stops",
              value: String(plannedStops),
              helper: "Across today's route days",
              tone: "neutral" as const,
              icon: MapPin,
            },
            {
              label: "Open tickets",
              value: String(openTickets.length),
              helper: "On NordRen ApS work",
              tone: "warning" as const,
              icon: TicketIcon,
            },
            {
              label: "Fleet",
              value: `${vehicles.length} vehicles`,
              helper: `${drivers.length} driver${drivers.length === 1 ? "" : "s"} on staff`,
              tone: "positive" as const,
              icon: Truck,
            },
          ].map((kpi, index) => (
            <div
              key={kpi.label}
              className={cn(
                "border-b border-border/70 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:[&:nth-child(odd)]:border-r-0",
                index > 1 && "sm:border-b-0",
              )}
            >
              <KpiItem {...kpi} />
            </div>
          ))}
        </section>

        <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.95fr)] lg:p-4">
          <section className="min-w-0 rounded-lg border border-border/70 bg-card/55">
            <PanelHeader
              title="Today's routes"
              helper="NordRen ApS route days — open one for stops, pickups, and sessions"
            />
            <div className="divide-y divide-border/70">
              {routes.map((route) => {
                const summary = routeProgressById.get(route.id)
                const progress =
                  summary?.progress ??
                  (route.status.toLowerCase() === "completed" ? 100 : 0)
                return (
                  <Link
                    key={route.id}
                    href={`/contractor-workspace/routes?module=routes&record=${route.id}`}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
                  >
                    <ProgressCircle
                      progress={progress}
                      color={summary?.color ?? "var(--chart-3)"}
                      size={22}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {route.name}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {route.facts.Area ?? route.context}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {route.facts.Driver ?? "Unassigned"} · {route.facts.Vehicle ?? "No vehicle"} · {route.value}
                      </p>
                    </div>
                    <StatusBadge status={route.status} />
                    <CaretRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                )
              })}
              {routes.length === 0 && (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  No route days are assigned to NordRen ApS today.
                </p>
              )}
            </div>
          </section>

          <div className="flex min-w-0 flex-col gap-3">
            <section className="min-w-0 rounded-lg border border-border/70 bg-card/55">
              <PanelHeader
                title="Open tickets"
                helper="Raised on NordRen ApS work — the office resolves them"
              />
              <div className="divide-y divide-border/70">
                {openTickets.slice(0, 4).map((ticket) => (
                  <Link
                    key={ticket.id}
                    href={`/contractor-workspace/tickets?module=tickets&record=${ticket.id}`}
                    className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{ticket.name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {ticket.context} · {ticket.updated}
                      </p>
                    </div>
                    <StatusBadge status={ticket.status} />
                  </Link>
                ))}
                {openTickets.length === 0 && (
                  <p className="px-4 py-6 text-sm text-muted-foreground">
                    No open tickets on NordRen ApS work.
                  </p>
                )}
              </div>
            </section>

            <section className="min-w-0 rounded-lg border border-border/70 bg-card/55">
              <PanelHeader
                title="Fleet"
                helper="Self-managed vehicles on contract area CA-Ø-2"
              />
              <div className="divide-y divide-border/70">
                {vehicles.slice(0, 4).map((vehicle) => (
                  <Link
                    key={vehicle.id}
                    href={`/contractor-workspace/fleet?module=vehicles&record=${vehicle.id}`}
                    className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                  >
                    <Truck className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{vehicle.name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {vehicle.context}
                      </p>
                    </div>
                    <StatusBadge status={vehicle.status} />
                  </Link>
                ))}
                {vehicles.length === 0 && (
                  <p className="px-4 py-6 text-sm text-muted-foreground">
                    No vehicles registered yet.
                  </p>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
