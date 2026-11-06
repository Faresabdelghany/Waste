"use client"

import { useState } from "react"

/**
 * Opens the record a Settings link names by its `record` param once `ready`
 * — the store hydrated and, on the Pilot, the module's rows read, so a record
 * made in the browser and an API row are found too — and again for each
 * other record a later link names, the pane staying mounted. A row no longer
 * there opens nothing; later edits keep their own state.
 */
export function useLinkedRecord<R extends { id: string }>(recordId: string | undefined, rows: readonly R[], ready: boolean, open: (record: R) => void): void {
  const [opened, setOpened] = useState<string | undefined>(undefined)
  if (ready && recordId !== undefined && recordId !== opened) {
    setOpened(recordId)
    const record = rows.find((candidate) => candidate.id === recordId)
    if (record !== undefined) open(record)
  }
}
