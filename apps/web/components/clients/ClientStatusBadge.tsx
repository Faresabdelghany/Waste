import { StatusBadge, type StatusTone } from "@/components/ui/status-badge"
import type { ClientStatus } from "@/lib/data/clients"

function statusLabel(status: ClientStatus): string {
    if (status === "prospect") return "Prospect"
    if (status === "active") return "Active"
    if (status === "on_hold") return "On hold"
    if (status === "completed") return "Completed"
    return "Archived"
}

function clientStatusTone(status: ClientStatus): StatusTone {
    if (status === "active") return "success"
    if (status === "on_hold") return "warning"
    if (status === "completed") return "info"
    return "neutral"
}

export function ClientStatusBadge({ status }: { status: ClientStatus }) {
    return (
        <StatusBadge tone={clientStatusTone(status)} dot className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium capitalize">
            {statusLabel(status)}
        </StatusBadge>
    )
}
