"use client"

// The Driver App's provider (Issue #145), in app/driver/layout.tsx so its one
// controller (lib/driver/driver-app.ts) outlives a move between the start
// screen and a route. It hands the controller the signed-in person and the
// client for their token as the API session changes — a refresh or a new
// sign-in drains what waited for it — opens the Command Queue in this
// origin's IndexedDB on mount, and tells it of the browser's `online` event.
// Nothing here decides anything; the controller holds the rules and the
// screens read its state (lib/external-store.ts says why the context carries
// the handle and not the state).
//
// The controller is never disposed: React's development double mount would
// leave it disposed and the page dead, and a controller left behind when the
// person leaves the Driver App only drains their queue, which is its job.
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"

import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { whoOf } from "@/lib/api/session"
import { APP_VERSION } from "@/lib/driver/app-version"
import { openCommandQueue } from "@/lib/driver/command-queue"
import { createDriverApp, type DriverAppController, type DriverAppState } from "@/lib/driver/driver-app"

const DriverAppContext = createContext<DriverAppController | null>(null)

export function DriverAppProvider({ children }: { children: ReactNode }) {
  const client = useApiClient()
  const { session } = useApiSession()
  const who = session === null ? null : whoOf(session)
  const [app] = useState<DriverAppController>(() =>
    createDriverApp({
      openQueue: () => openCommandQueue(window.indexedDB),
      geolocation: typeof navigator === "undefined" ? null : (navigator.geolocation ?? null),
      appVersion: APP_VERSION,
    }),
  )

  useEffect(() => {
    app.setSession(who === null ? null : { who, client })
  }, [app, who, client])

  useEffect(() => {
    void app.load()
    const online = () => app.online()
    window.addEventListener("online", online)
    return () => window.removeEventListener("online", online)
  }, [app])

  return <DriverAppContext.Provider value={app}>{children}</DriverAppContext.Provider>
}

export function useDriverApp(): DriverAppController {
  const app = useContext(DriverAppContext)
  if (!app) throw new Error("useDriverApp must be used within DriverAppProvider")
  return app
}

export function useDriverAppState(): DriverAppState {
  const app = useDriverApp()
  return useSyncExternalStore(app.store.subscribe, app.store.getSnapshot, app.store.getServerSnapshot)
}
