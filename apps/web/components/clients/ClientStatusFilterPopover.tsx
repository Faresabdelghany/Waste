"use client"

import { useState } from "react"
import { CaretDown } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ClientStatusBadge } from "@/components/clients/ClientStatusBadge"
import { clients, type ClientStatus } from "@/lib/data/clients"
import { cn } from "@/lib/utils"

interface ClientStatusFilterPopoverProps {
    initialStatus: ClientStatus
}

const STATUS_ITEMS: { value: ClientStatus; label: string; meta?: string }[] = [
    { value: "on_hold", label: "On hold" },
    { value: "prospect", label: "Prospect" },
    { value: "active", label: "Active", meta: "2 projects" },
    { value: "completed", label: "Completed" },
    { value: "archived", label: "Archived" },
]

export function ClientStatusFilterPopover({ initialStatus }: ClientStatusFilterPopoverProps) {
    const [open, setOpen] = useState(false)
    const [status, setStatus] = useState<ClientStatus>(initialStatus)

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    type="button"
                    className="whitespace-normal shrink h-auto has-[>svg]:px-3 flex w-full items-center justify-between gap-4 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground cursor-pointer transition-colors hover:bg-muted sm:w-auto sm:justify-start sm:gap-8 hover:text-foreground dark:hover:bg-muted"
                >
                    <span className="text-xs text-muted-foreground">Stage</span>
                    <span className="inline-flex items-center gap-2 rounded-full p-0 text-xs font-medium text-foreground">
                        <ClientStatusBadge status={status} />
                        <CaretDown className="size-3 text-muted-foreground" />
                    </span>
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-64 rounded-xl p-2">
                <div className="space-y-1.5">
                    {STATUS_ITEMS.map((item) => {
                        const isActive = item.value === status
                        return (
                            <Button
                                variant="ghost"
                                key={item.value}
                                type="button"
                                onClick={() => {
                                    setStatus(item.value)
                                    setOpen(false)
                                }}
                                className={cn("gap-0 whitespace-normal font-normal shrink h-auto has-[>svg]:px-3 cursor-default hover:bg-transparent hover:text-inherit dark:hover:bg-transparent",
                                    "flex w-full items-center justify-between rounded-full px-3 py-1.5 text-sm transition-colors",
                                    isActive ? "bg-muted hover:bg-muted dark:hover:bg-muted" : "hover:bg-muted/70 dark:hover:bg-muted/70",
                                )}
                            >
                                <ClientStatusBadge status={item.value} />
                                {item.meta && (
                                    <span className="text-xs text-muted-foreground">{item.meta}</span>
                                )}
                            </Button>
                        )
                    })}
                </div>
            </PopoverContent>
        </Popover>
    )
}
