"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { formatDistanceToNow } from "date-fns"
import { Bell, ChatCircleDots, CheckCircle, EnvelopeSimple } from "@phosphor-icons/react/dist/ssr"

import { PageActions, PageTopBar } from "@/components/page-layout"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { InboxFilterPopover } from "./InboxFilterPopover"
import { markAllInboxRead, markInboxItemRead, useInboxItems } from "./inbox-store"
import { INBOX_FIXTURE_ITEMS, inboxTypeLabel, type InboxItemType } from "@/lib/data/inbox"

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

export function InboxPage() {
    const [tab, setTab] = useState<"all" | "unread" | "mentions">("all")
    // `?item=` is the item the top bar's bell opened; the page stays mounted
    // across navigations, so a later one selects its item too.
    const requestedId = useSearchParams().get("item")
    const [selectedId, setSelectedId] = useState<string | null>(requestedId ?? INBOX_FIXTURE_ITEMS[0]?.id ?? null)
    const [lastRequestedId, setLastRequestedId] = useState(requestedId)
    if (requestedId !== lastRequestedId) {
        setLastRequestedId(requestedId)
        if (requestedId) setSelectedId(requestedId)
    }
    const [filters, setFilters] = useState<InboxFilters>({ types: [], clients: [] })
    const inboxItems = useInboxItems()

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

    const markItemAsRead = markInboxItemRead
    const markAllAsRead = markAllInboxRead

    return (
        <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
            <header className="flex flex-col border-b border-border/40">
                <PageTopBar>
                    <Breadcrumbs items={[{ label: "Service Inbox" }]} />
                </PageTopBar>

                <div className="flex flex-col gap-2 px-4 pb-3 pt-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex w-full items-center justify-between gap-2 md:w-auto md:justify-start">
                        <InboxFilterPopover
                            filters={filters}
                            availableClients={availableClients}
                            onChange={setFilters}
                        />
                        <PageActions>
                            <Button size="sm" variant="ghost" onClick={markAllAsRead}>
                                Mark all as read
                            </Button>
                        </PageActions>
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
                                                {inboxTypeLabel(item.type)}
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
