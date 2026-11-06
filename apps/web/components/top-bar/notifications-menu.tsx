"use client"

import { Bell } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** The top bar's bell. The API has no notification feed yet, so it says there are none. */
export function NotificationsMenu() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Notifications"
        >
          <Bell className="h-[18px] w-[18px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <p className="text-sm font-medium">Notifications</p>
        </div>
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Bell className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No notifications yet.</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
