"use client"

// Settings → Areas & Zones: a planning area's boundary versions on the
// Pilot (O21 of #290). The API holds an area's outline as versions one after
// another, never two in force on a day; this dialog lists every one by the
// day it starts — in force, upcoming or ended on the project's day — and
// writes the next version from a day: the version still in force then is
// ended there and the new drawing added from it, through the area's adapter
// (lib/api/records/planning.ts), so the store tells a refusal in the API's
// words and the dialog stays open.

import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import { boundaryVersionsOf, NEXT_VERSION_FROM_KEY, NEXT_VERSION_GEOMETRY_KEY, type BoundaryVersionRow } from "@/lib/api/records/planning"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import { formatServiceDate } from "@waste/domain/route-schemes/recurrence"

const STANDING_CLASSES: Record<BoundaryVersionRow["standing"], string> = {
  "in force": "border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-100",
  upcoming: "border-transparent bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-100",
  ended: "text-muted-foreground",
}

export function PlanningAreaVersionsDialog({ record, open, onOpenChange }: { record: BusinessRecord; open: boolean; onOpenChange: (open: boolean) => void }) {
  const versions = boundaryVersionsOf(record)
  const [from, setFrom] = useState("")
  const [geometry, setGeometry] = useState("")
  const [pending, setPending] = useState(false)
  const { upsertRecord } = useBusinessRecordStore()

  const submit = () => {
    setPending(true)
    const next: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, [NEXT_VERSION_FROM_KEY]: from, [NEXT_VERSION_GEOMETRY_KEY]: geometry } }
    whenSaved(
      upsertRecord(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId, next),
      () => {
        onOpenChange(false)
        toast.success(`Next boundary of ${record.name} from ${formatServiceDate(from)}`, { description: "The version in force until then ends the day before; the map draws the new one from that day." })
      },
      () => setPending(false),
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Boundary versions · {record.name}</DialogTitle>
          <DialogDescription>Each version of the area&apos;s outline is in force from its first day to its last; one at a time. Route schemes name the area, so they match inside whichever version is in force on a collection&apos;s day.</DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Standing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm text-muted-foreground">
                    No boundary drawn yet.
                  </TableCell>
                </TableRow>
              ) : (
                versions.map((version) => (
                  <TableRow key={version.id}>
                    <TableCell className="whitespace-nowrap text-sm">{formatServiceDate(version.validFrom)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{version.lastDay === null ? "ongoing" : formatServiceDate(version.lastDay)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STANDING_CLASSES[version.standing]}`}>
                        {version.standing}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <section className="space-y-3 rounded-lg border border-border/60 p-3" aria-labelledby="next-version-heading">
          <h3 id="next-version-heading" className="text-sm font-semibold">
            Next version from a day
          </h3>
          <div className="space-y-1.5">
            <Label htmlFor="next-version-from">In force from</Label>
            <Input id="next-version-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="next-version-geometry">Boundary</Label>
            <Textarea id="next-version-geometry" rows={4} placeholder='A GeoJSON Polygon, or a list of [lng, lat] positions' value={geometry} onChange={(event) => setGeometry(event.target.value)} />
          </div>
        </section>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={pending || from === "" || geometry.trim() === ""} onClick={submit}>
            {pending ? "Saving…" : "Add next version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
