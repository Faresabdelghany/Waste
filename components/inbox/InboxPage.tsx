"use client"

import { useEffect, useMemo, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { Bell, ChatCircleDots, CheckCircle, EnvelopeSimple } from "@phosphor-icons/react/dist/ssr"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { InboxFilterPopover } from "./InboxFilterPopover"

type InboxItemType = "comment" | "task" | "client" | "project" | "system"

type InboxItem = {
    id: string
    title: string
    preview: string
    createdAt: Date
    type: InboxItemType
    unread: boolean
    client?: string
    project?: string
}

const MOCK_INBOX_ITEMS: InboxItem[] = [
    {
        id: "1",
        title: "Blocked access reported at stop 18",
        preview:
            "The driver could not access the organic-waste containers at Parkvej 18.\n\nEvidence\n- Gate was locked at 08:42.\n- Driver attached one photo and a location stamp.\n- The stop was marked failed with reason: blocked access.\n\nSuggested next steps\n- Contact the property manager.\n- Approve a recollection for the afternoon recovery route.",
        createdAt: new Date(Date.now() - 1000 * 60 * 10),
        type: "comment",
        unread: true,
        client: "Østerbro Housing",
        project: "RC-1048 · Østerbro Organic",
    },
    {
        id: "2",
        title: "You were assigned a new ticket",
        preview:
            "A service ticket has been assigned to you for a reported container overflow.\n\nScope\n- Review the customer photo and service history.\n- Confirm whether the scheduled collection was completed.\n- Decide between a recollection or a container-capacity adjustment.\n\nResponse target\n- First customer update is due within two hours.",
        createdAt: new Date(Date.now() - 1000 * 60 * 45),
        type: "task",
        unread: true,
        client: "Amager District",
        project: "RC-1051 · Amager Glass",
    },
    {
        id: "3",
        title: "Customer agreement moved to Active",
        preview:
            "The Copenhagen Central service agreement is now active.\n\nWhat this enables\n- Covered properties can be added to published route schemes.\n- Included waste fractions and service frequencies are billable.\n- Exceptions can now be tracked against the agreement SLA.",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3),
        type: "client",
        unread: false,
        client: "Copenhagen Central",
    },
    {
        id: "4",
        title: "Route completed with all proof captured",
        preview:
            "RC-1044 has been completed and closed.\n\nCompletion summary\n- 42 of 42 planned stops were serviced.\n- Disposal weight was recorded at the transfer station.\n- Required proof was captured for every exception.\n\nThe route is ready for billing review.",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6),
        type: "project",
        unread: false,
        project: "RC-1044 · Nørrebro Mixed",
    },
    {
        id: "5",
        title: "Daily operations summary is ready",
        preview:
            "Your Copenhagen operations summary is ready.\n\nRoutes\n- 4 routes are currently in progress.\n- 1 route is delayed by more than 20 minutes.\n- 87% of planned stops are complete.\n\nExceptions\n- 3 failed stops require review.\n- 1 recollection needs approval.\n\nSuggested focus\n- Resolve blocked-access tickets before the afternoon dispatch.",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
        type: "system",
        unread: true,
    },
    {
        id: "6",
        title: "New contract route is ready for planning",
        preview:
            "Harbor Commercial Cardboard has been created from a draft customer agreement.\n\nPlanning checklist\n- Confirm service points and access instructions.\n- Allocate containers from warehouse stock.\n- Assign a suitable vehicle and driver.\n- Publish the first collection date after commercial approval.",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 30),
        type: "project",
        unread: true,
        client: "Harbor Offices ApS",
        project: "Harbor Commercial Cardboard",
    },
    {
        id: "7",
        title: "Vehicle capacity warning on Amager route",
        preview:
            "The estimated glass volume is above the assigned vehicle's safe capacity.\n\nBefore dispatch\n- Review historical weights for the route.\n- Reassign a larger vehicle or add an unloading trip.\n- Confirm that the receiving facility remains within its opening window.",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 40),
        type: "task",
        unread: false,
        client: "Amager District",
        project: "RC-1051 · Amager Glass",
    },
    {
        id: "8",
        title: "New property contact added",
        preview:
            "Mikkel Sørensen has been added as the service contact for Parkvej 18.\n\nContact scope\n- Access-window coordination.\n- Locked-gate and container-location issues.\n- Approval of urgent recollections.\n\nThe contact is now available from the customer and property views.",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 60),
        type: "client",
        unread: false,
        client: "Østerbro Housing",
        project: "RC-1048 · Østerbro Organic",
    },
]

type InboxFilters = {
    types: InboxItemType[]
    clients: string[]
}

function getTypeIcon(type: InboxItemType) {
    if (type === "comment") return ChatCircleDots
    if (type === "task") return CheckCircle
    if (type === "client") return EnvelopeSimple
    if (type === "project") return Bell
    return Bell
}

function getTypeLabel(type: InboxItemType): string {
    if (type === "comment") return "Comment"
    if (type === "task") return "Ticket"
    if (type === "client") return "Customer"
    if (type === "project") return "Route"
    return "Update"
}

export function InboxPage() {
    const [tab, setTab] = useState<"all" | "unread" | "mentions">("all")
    const [selectedId, setSelectedId] = useState<string | null>(MOCK_INBOX_ITEMS[0]?.id ?? null)
    const [filters, setFilters] = useState<InboxFilters>({ types: [], clients: [] })
    const [inboxItems, setInboxItems] = useState<InboxItem[]>(MOCK_INBOX_ITEMS)

    const availableClients = useMemo(
        () =>
            Array.from(new Set(inboxItems.map((item) => item.client).filter((value): value is string => !!value))),
        [inboxItems],
    )

    const items = useMemo(() => {
        let list = [...inboxItems]

        if (tab === "unread") {
            list = list.filter((item) => item.unread)
        }

        if (filters.types.length) {
            list = list.filter((item) => filters.types.includes(item.type))
        }

        if (filters.clients.length) {
            list = list.filter((item) => item.client && filters.clients.includes(item.client))
        }
        return list
    }, [tab, filters, inboxItems])

    useEffect(() => {
        if (!items.length) {
            setSelectedId(null)
            return
        }

        if (!selectedId || !items.some((item) => item.id === selectedId)) {
            setSelectedId(items[0].id)
        }
    }, [items, selectedId])

    const selected = useMemo(() => {
        if (!selectedId) return null
        return inboxItems.find((item) => item.id === selectedId) ?? null
    }, [selectedId, inboxItems])

    const markItemAsRead = (id: string) => {
        setInboxItems((prev) => prev.map((item) => (item.id === id ? { ...item, unread: false } : item)))
    }

    const markAllAsRead = () => {
        setInboxItems((prev) => prev.map((item) => (item.unread ? { ...item, unread: false } : item)))
    }

    return (
        <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
            <header className="flex flex-col border-b border-border/40">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border/70">
                    <div className="flex items-center gap-3">
                        <SidebarTrigger className="h-8 w-8 rounded-lg hover:bg-accent text-muted-foreground" />
                        <p className="text-base font-medium text-foreground">Service Inbox</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" onClick={markAllAsRead}>
                            Mark all as read
                        </Button>
                    </div>
                </div>

                <div className="flex flex-col gap-2 px-4 pb-3 pt-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex w-full md:w-auto md:justify-start">
                        <InboxFilterPopover
                            filters={filters}
                            availableClients={availableClients}
                            onChange={setFilters}
                        />
                    </div>

                    <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="w-full md:w-auto">
                        <TabsList className="inline-flex w-full justify-between rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs md:w-auto md:justify-start h-8">
                            <TabsTrigger
                                value="all"
                                className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground"
                            >
                                All
                            </TabsTrigger>
                            <TabsTrigger
                                value="unread"
                                className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground"
                            >
                                Unread
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </header>

            <div className="flex-1 min-h-0 flex flex-col md:flex-row">
                <div className="border-b border-border/40 md:border-b-0 md:border-r md:w-[320px] lg:w-[360px] flex flex-col min-h-0">
                    <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
                        {items.map((item) => {
                            const Icon = getTypeIcon(item.type)
                            const isSelected = item.id === selectedId

                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => {
                                        setSelectedId(item.id)
                                        if (item.unread) {
                                            markItemAsRead(item.id)
                                        }
                                    }}
                                    className={cn(
                                        "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                                        isSelected ? "bg-muted" : "hover:bg-muted/70",
                                    )}
                                >
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                        <Icon className="h-4 w-4" />
                                    </div>
                                    <div className="flex flex-1 flex-col gap-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                            <p className="text-xs font-medium text-foreground truncate">
                                                {item.title}
                                            </p>
                                            <span className="shrink-0 text-[10px] text-muted-foreground">
                                                {formatDistanceToNow(item.createdAt, { addSuffix: true })}
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-muted-foreground line-clamp-2">
                                            {item.preview}
                                        </p>
                                        <div className="flex items-center gap-2 mt-1">
                                            <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px] font-medium">
                                                {getTypeLabel(item.type)}
                                            </Badge>
                                            {item.client && (
                                                <span className="text-[10px] text-muted-foreground truncate">
                                                    {item.client}
                                                </span>
                                            )}
                                            {item.project && (
                                                <span className="text-[10px] text-muted-foreground truncate">
                                                    {item.project}
                                                </span>
                                            )}
                                            {item.unread && (
                                                <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500" />
                                            )}
                                        </div>
                                    </div>
                                </button>
                            )
                        })}
                    </div>
                </div>

                <div className="flex-1 min-h-0 flex flex-col">
                    {selected ? (
                        <div className="flex-1 min-h-0 flex flex-col px-4 py-4 gap-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex items-start gap-3">
                                    <Avatar className="h-9 w-9">
                                        <AvatarFallback className="text-xs font-semibold">
                                            {selected.client?.[0] ?? selected.project?.[0] ?? "N"}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="flex flex-col gap-1 min-w-0">
                                        <p className="text-sm font-medium text-foreground">
                                            {selected.title}
                                        </p>
                                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                            {selected.client && <span>{selected.client}</span>}
                                            {selected.project && (
                                                <span className="flex items-center gap-1">
                                                    <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                                                    <span>{selected.project}</span>
                                                </span>
                                            )}
                                            <span className="flex items-center gap-1">
                                                <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                                                <span>{formatDistanceToNow(selected.createdAt, { addSuffix: true })}</span>
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Badge variant={selected.unread ? "default" : "outline"} className="h-6 rounded-full px-2 text-[10px]">
                                        {selected.unread ? "Unread" : "Read"}
                                    </Badge>
                                </div>
                            </div>

                            <div className="flex-1 min-h-0 rounded-xl border border-border bg-card/80 px-4 py-3">
                                <div className="text-sm leading-relaxed text-foreground">
                                    {selected.preview.split("\n").map((line, index, allLines) => {
                                        const trimmed = line.trim()

                                        if (!trimmed) {
                                            return <div key={index} className="h-2" />
                                        }

                                        const next = (allLines[index + 1] ?? "").trim()
                                        const isBullet = trimmed.startsWith("-")
                                        const isHeading = !isBullet && next.startsWith("-")

                                        if (isHeading) {
                                            return (
                                                <p key={index} className="mt-2 text-xs font-semibold text-foreground">
                                                    {trimmed}
                                                </p>
                                            )
                                        }

                                        if (isBullet) {
                                            const content = trimmed.replace(/^[-]+\s*/, "")
                                            return (
                                                <p key={index} className="pl-4 text-[13px]">
                                                    <span className="mr-1">•</span>
                                                    {content}
                                                </p>
                                            )
                                        }

                                        return (
                                            <p key={index} className="text-[13px]">
                                                {trimmed}
                                            </p>
                                        )
                                    })}
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-2">
                                <div className="flex items-center gap-2">
                                    <Button size="sm" variant="outline">
                                        Open related work
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => {
                                            if (selected.unread) {
                                                markItemAsRead(selected.id)
                                            }
                                        }}
                                    >
                                        Mark as read
                                    </Button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-muted-foreground">
                            Select an item from the list to see details.
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
