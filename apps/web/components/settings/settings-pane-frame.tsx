"use client"

import { createContext, useContext } from "react"

import { settingsPaneHeading, type SettingsPane } from "@/lib/modules/settings-panes"

/** What frames the pane Settings shows, from its table entry: the bar above it, its title and its description. */
export type SettingsPaneFrame = { heading: string; title: string; description: string }

const FrameContext = createContext<SettingsPaneFrame | null>(null)

export function SettingsPaneFrameProvider({ pane, children }: { pane: SettingsPane; children: React.ReactNode }) {
  return <FrameContext.Provider value={{ heading: settingsPaneHeading(pane), title: pane.title, description: pane.description }}>{children}</FrameContext.Provider>
}

/** The frame of the pane shown, or null outside Settings. */
export function useSettingsPaneFrame(): SettingsPaneFrame | null {
  return useContext(FrameContext)
}
