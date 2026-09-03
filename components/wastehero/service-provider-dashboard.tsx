"use client"

import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"

import {
  SERVICE_PROVIDER_PORTFOLIO_SUMMARY,
  SERVICE_PROVIDER_ROUTE_PERFORMANCE_ROWS,
  SERVICE_PROVIDER_THROUGHPUT_SERIES,
  SERVICE_PROVIDER_TICKET_ATTENTION_ROWS,
} from "@/lib/data/performance-dashboard"

const PerformanceControlRoom = dynamic(
  () =>
    import("@/components/performance-control-room").then(
      (module) => module.PerformanceControlRoom,
    ),
  { ssr: false },
)

// The operator's Route performance control room, scoped to NordRen ApS —
// same layout and interactions, service-provider-only routes and totals.
export function ServiceProviderDashboard() {
  const router = useRouter()

  // Dashboard rows use route codes (RC-1048); route records use ids (route-day-1048).
  const openRoute = (routeId: string) => {
    const recordId = `route-day-${routeId.replace(/^RC-/, "")}`
    router.push(`/service-provider-workspace/routes?module=routes&record=${recordId}`)
  }

  return (
    <PerformanceControlRoom
      breadcrumbLabel="Dashboard"
      subtitle="NordRen ApS · Service area CA-Ø-2"
      rows={SERVICE_PROVIDER_ROUTE_PERFORMANCE_ROWS}
      series={SERVICE_PROVIDER_THROUGHPUT_SERIES}
      summary={SERVICE_PROVIDER_PORTFOLIO_SUMMARY}
      tickets={SERVICE_PROVIDER_TICKET_ATTENTION_ROWS}
      ticketsBasePath="/service-provider-workspace/tickets"
      hideTableColumns={["proof", "exceptions", "trend"]}
      onRouteOpen={openRoute}
    />
  )
}
