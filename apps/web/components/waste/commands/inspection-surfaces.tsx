"use client"
// Operate › Inspections on the Pilot (M23 of #293): an inspection's details.
// Its photos, read as URLs the API signs for minutes and asked again when a
// photo is added; while it is open, Add photo — the file made a JPEG as the
// Driver App makes its own, signed, put straight to Storage and appended by
// its key through the client, then the row read back — and Close, which ends
// it. A closed inspection offers nothing and says so.
import { useEffect, useRef, useState } from "react"
import { Camera, CheckCircle } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { InspectionPhotoLink } from "@waste/contracts/field-inspections"
import { Button } from "@/components/ui/button"
import { useApiClient } from "@/components/waste/api-session-store"
import { useBusinessRecordStore, useServerResolver } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { addInspectionPhoto, CLOSE_INSPECTION, inspectionPhotoLinks } from "@/lib/api/records/inspections"
import { problemOfError } from "@/lib/api/records/server-records"
import { inspectionOpen, INSPECTIONS_MODULE } from "@/lib/data/inspections"
import { photoOf } from "@/lib/driver/proof-images"

/** An inspection's photos, its Add photo and its Close. */
export function InspectionSurface({ record }: RowSurfaceProps) {
  const client = useApiClient()
  const resolver = useServerResolver()
  const { refreshRecord } = useBusinessRecordStore()
  const moduleReady = useModuleReady(INSPECTIONS_MODULE)
  const { busy, run } = useCommandRunner(INSPECTIONS_MODULE, record.id)
  const serverId = resolver.serverIdOf(record.id)
  const open = inspectionOpen(record)
  const photoCount = record.facts.Photos ?? "0"
  const [links, setLinks] = useState<{ key: string; rows: InspectionPhotoLink[] | null; problem: string | null }>({ key: "", rows: null, problem: null })
  const [adding, setAdding] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const key = `${serverId ?? ""}|${photoCount}`

  useEffect(() => {
    if (client === null || serverId === undefined || photoCount === "0") return
    let current = true
    inspectionPhotoLinks(client, serverId).then(
      (answer) => current && setLinks({ key, rows: answer.items, problem: null }),
      (error: unknown) => current && setLinks({ key, rows: null, problem: problemSentence(problemOfError(error)) }),
    )
    return () => {
      current = false
    }
  }, [client, key, photoCount, serverId])
  const shown = links.key === key ? links : { rows: null, problem: null }

  const addPhoto = async (file: File) => {
    if (client === null || serverId === undefined) return
    setAdding(true)
    try {
      await addInspectionPhoto(client, serverId, await photoOf(file))
      await refreshRecord(INSPECTIONS_MODULE.workspaceId, INSPECTIONS_MODULE.moduleId, record.id)
      toast.success("Photo added")
    } catch (error) {
      toast.error("The photo was not added", { description: problemSentence(problemOfError(error)) })
    } finally {
      setAdding(false)
      if (picker.current !== null) picker.current.value = ""
    }
  }

  return (
    <section className="space-y-3" data-testid="inspection-commands">
      <h3 className="text-sm font-semibold">Photos</h3>
      {photoCount === "0" ? <p className="text-sm text-muted-foreground">No photos yet.</p> : null}
      {shown.problem !== null && <p className="text-sm text-muted-foreground">{shown.problem}</p>}
      {shown.rows !== null && shown.rows.length > 0 && (
        <ul className="grid grid-cols-3 gap-2" aria-label="Inspection photos">
          {shown.rows.map((photo) => (
            <li key={photo.photoId}>
              {photo.url === null ? (
                <span className="text-xs text-muted-foreground">Not uploaded</span>
              ) : (
                <a href={photo.url} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a signed Storage URL that lapses in minutes, never one next/image may cache */}
                  <img src={photo.url} alt="Inspection photo" className="aspect-square w-full rounded-md object-cover" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {!moduleReady && <p className="text-sm text-muted-foreground">The inspections are being read from the API; their commands follow.</p>}
      {open ? (
        <div className="flex flex-wrap gap-2">
          <input
            ref={picker}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="Photo file"
            data-testid="inspection-photo-file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) void addPhoto(file)
            }}
          />
          <Button variant="outline" size="sm" disabled={!moduleReady || adding || serverId === undefined} onClick={() => picker.current?.click()}>
            <Camera aria-hidden />
            {adding ? "Adding photo…" : "Add photo"}
          </Button>
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => run(CLOSE_INSPECTION, {}, () => toast.success("Inspection closed"))}>
            <CheckCircle aria-hidden />
            Close
          </Button>
        </div>
      ) : (
        moduleReady && <p className="text-sm text-muted-foreground">Closed: the inspection changes no more.</p>
      )}
    </section>
  )
}
