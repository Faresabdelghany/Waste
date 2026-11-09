"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { GearSix, Key, Moon, SignOut, Sun } from "@phosphor-icons/react/dist/ssr"

import { useAppTheme } from "@/components/app-theme-provider"
import { ChangePasswordDialog } from "@/components/auth/change-password-dialog"
import { useActorName, useShellIdentity } from "@/components/platform/shell-identity"
import { useApiConfigured, useApiSession } from "@/components/platform/api-session-store"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { initialsOf } from "@/lib/data/account-profile"
import { settingsHref } from "@/lib/modules/settings-panes"
import type { LinearThemeId } from "@/lib/app-themes"
import { cn } from "@/lib/utils"

// The two themes the menu switches between; Settings › Account & appearance
// offers every one, Dawn, Pale and a custom palette among them.
const THEME_CHOICES: ReadonlyArray<{ id: LinearThemeId; label: string; icon: typeof Sun }> = [
  { id: "ash", label: "Light", icon: Sun },
  { id: "midnight", label: "Dark", icon: Moon },
]

/**
 * The account at the right of the top bar. On the Pilot it is `/me`'s, with
 * Change password and Sign out (the session drops and the gate sends the page
 * to /login); in fixture mode it is the shell's persona.
 */
export function TopAccountMenu() {
  const apiConfigured = useApiConfigured()
  const { me, session, signOut } = useApiSession()
  const { fixture, offersSettings } = useShellIdentity()
  const { selection, selectTheme } = useAppTheme()
  const pathname = usePathname()
  const router = useRouter()
  const [changingPassword, setChangingPassword] = useState(false)

  const email = apiConfigured ? (me?.user.email ?? session?.email ?? "") : ""
  const name = useActorName()
  const detail = apiConfigured ? (me?.role.name ?? "") : fixture.detail
  const initials = apiConfigured ? initialsOf(name) : fixture.initials

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="rounded-full p-0" aria-label={`Account: ${name}`}>
            <Avatar className="h-8 w-8">
              {!apiConfigured && fixture.avatarUrl && <AvatarImage src={fixture.avatarUrl} alt="" />}
              <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initials}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="flex items-center gap-3 py-2 font-normal">
            <Avatar className="h-10 w-10">
              {!apiConfigured && fixture.avatarUrl && <AvatarImage src={fixture.avatarUrl} alt="" />}
              <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">{initials}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{name}</span>
              {email && email !== name && <span className="block truncate text-xs text-muted-foreground">{email}</span>}
              {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {offersSettings && (
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href={settingsHref("account", { from: pathname })}>
                <GearSix className="h-4 w-4" />
                Account settings
              </Link>
            </DropdownMenuItem>
          )}
          <div className="px-2 py-1.5">
            <p className="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Theme</p>
            <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-0.5">
              {THEME_CHOICES.map(({ id, label, icon: Icon }) => (
                <Button
                  variant="unstyled"
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selection === id}
                  onClick={() => selectTheme(id)}
                  className={cn(
                    "flex h-7 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground",
                    selection === id && "bg-background font-medium text-foreground shadow-xs",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <DropdownMenuSeparator />
          {apiConfigured && (
            <DropdownMenuItem className="cursor-pointer" onSelect={() => setChangingPassword(true)}>
              <Key className="h-4 w-4" />
              Change password
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="cursor-pointer text-destructive focus:text-destructive"
            onSelect={() => (apiConfigured ? void signOut() : router.push("/login"))}
          >
            <SignOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {apiConfigured && <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />}
    </>
  )
}
