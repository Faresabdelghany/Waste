"use client"

// The signed-in person at the foot of a sidebar, on the Pilot (Issue #150):
// name, e-mail and role as `/me` answered, never a fixture persona, and the
// account's two actions — Change password and Sign out. Until `/me` has
// answered, the e-mail Auth gave at sign-in stands in for the name. A sign-out
// needs no navigation here: the session drops, and the gate sends the page
// to /login. In fixture mode each sidebar keeps its persona menu instead.
import { useState } from "react"
import { ChevronRight, KeyRound, LogOut } from "lucide-react"

import { ChangePasswordDialog } from "@/components/auth/change-password-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useApiSession } from "@/components/waste/api-session-store"
import { cn } from "@/lib/utils"

/** The first letters of the first and last names; one letter for a single word. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? ""
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : ""
  return `${first}${last}`.toUpperCase()
}

export function AccountMenu({ className }: { className?: string }) {
  const { me, session, signOut } = useApiSession()
  const [changingPassword, setChangingPassword] = useState(false)
  const email = me?.user.email ?? session?.email ?? ""
  const name = me?.user.fullName ?? email
  const role = me?.role.name ?? ""

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn("flex w-full cursor-pointer items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-sidebar-accent", className)}>
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-accent-foreground">{initialsOf(name)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{name}</span>
              <span className="truncate text-xs text-sidebar-foreground/60">{role}</span>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-sidebar-foreground/55" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <p className="truncate text-sm font-medium">{name}</p>
            {email !== name && <p className="truncate text-xs text-muted-foreground">{email}</p>}
            {role && <p className="truncate text-xs text-muted-foreground">{role}</p>}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onSelect={() => setChangingPassword(true)}>
            <KeyRound className="h-4 w-4" />
            Change password
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer text-destructive focus:text-destructive" onSelect={() => void signOut()}>
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </>
  )
}
