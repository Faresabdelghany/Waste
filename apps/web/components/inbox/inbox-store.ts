"use client"

import { useSyncExternalStore } from "react"

import { createExternalStore } from "@/lib/external-store"
import { INBOX_FIXTURE_ITEMS, type InboxItem } from "@/lib/data/inbox"

// The Service Inbox's items and which are read, shared by the Inbox page and
// the top bar's bell. Held for the browser session only, as the page's own
// state was.
const inboxStore = createExternalStore<readonly InboxItem[]>(INBOX_FIXTURE_ITEMS)

export function useInboxItems(): readonly InboxItem[] {
  return useSyncExternalStore(inboxStore.subscribe, inboxStore.getSnapshot, inboxStore.getServerSnapshot)
}

export function markInboxItemRead(id: string): void {
  inboxStore.set((items) =>
    items.some((item) => item.id === id && item.unread)
      ? items.map((item) => (item.id === id ? { ...item, unread: false } : item))
      : items,
  )
}

export function markAllInboxRead(): void {
  inboxStore.set((items) =>
    items.some((item) => item.unread) ? items.map((item) => (item.unread ? { ...item, unread: false } : item)) : items,
  )
}
