"use client"

import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { Bell } from "@phosphor-icons/react/dist/ssr"

import { markAllInboxRead, markInboxItemRead, useInboxItems } from "@/components/inbox/inbox-store"
import { useShellIdentity } from "@/components/top-bar/shell-identity"
import { useApiConfigured } from "@/components/waste/api-session-store"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { inboxTypeLabel } from "@/lib/data/inbox"
import { cn } from "@/lib/utils"

const SHOWN = 6

/**
 * The top bar's bell. In the office's shell in fixture mode it lists the
 * Service Inbox; the API has no notification feed yet, so on the Pilot, and
 * in a restricted shell, it says there are none.
 */
export function NotificationsMenu() {
  const apiConfigured = useApiConfigured()
  const { readsInbox } = useShellIdentity()
  const inboxItems = useInboxItems()
  const items = readsInbox && !apiConfigured ? inboxItems : []
  const unread = items.filter((item) => item.unread).length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative rounded-full text-muted-foreground hover:text-foreground"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && (
            <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <p className="text-sm font-medium">Notifications</p>
          {unread > 0 && (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={markAllInboxRead}>
              Mark all as read
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Bell className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No notifications yet.</p>
          </div>
        ) : (
          <>
            <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto">
              {items.slice(0, SHOWN).map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/inbox?item=${encodeURIComponent(item.id)}`}
                    onClick={() => markInboxItemRead(item.id)}
                    className="flex gap-3 px-4 py-3 hover:bg-accent"
                  >
                    <span
                      aria-hidden
                      className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", item.unread ? "bg-primary" : "bg-transparent")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm", item.unread && "font-medium")}>{item.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {inboxTypeLabel(item.type)}
                        {item.client ? ` · ${item.client}` : ""} · {formatDistanceToNow(item.createdAt, { addSuffix: true })}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-border px-4 py-2">
              <Link href="/inbox" className="text-xs font-medium text-primary hover:underline">
                Open Service Inbox
              </Link>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
