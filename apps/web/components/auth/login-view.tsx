"use client"

import Image from "next/image"
import { useRouter } from "next/navigation"
import { ArrowRight } from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { DEMO_ACCOUNTS } from "@/lib/data/demo-accounts"

export function LoginView() {
  const router = useRouter()

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
        <div className="px-6 pt-8 pb-6">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Image src="/logo-wrapper.png" alt="WasteHero" width={24} height={24} />
            </div>
            <h1 className="mt-2 text-xl font-semibold">Sign in to WasteHero</h1>
            <p className="text-sm text-muted-foreground">
              Choose an account to continue.
            </p>
          </div>

          <div className="mt-6 space-y-2">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.id}
                type="button"
                className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted/20 p-3 text-left transition-colors hover:bg-muted/60"
                onClick={() => router.push(account.homePath)}
              >
                <Avatar className="h-9 w-9">
                  {account.avatarSrc && <AvatarImage src={account.avatarSrc} />}
                  <AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                    {account.initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{account.detail}</p>
                  <p className="truncate text-xs text-muted-foreground/70">{account.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-muted-foreground/80">{account.viewLabel}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-border/70 bg-muted/40 px-6 py-4 text-center text-xs text-muted-foreground">
          Demo environment — accounts sign in without a password.
        </div>
      </div>
    </main>
  )
}
