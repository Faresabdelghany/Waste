"use client"

// A Route Scheme's Seasons on its page (O17 of #290): the stretches of every
// year the scheme runs at another cadence, listed and edited as one set. The
// editor checks the set with the domain's `seasonProblems`, the contracts'
// rules in their words, and saves the record with the set whole under
// `SCHEME_SEASONS_KEY`; on the Pilot the adapter sends it as the patch's
// `seasons`, in fixture mode the record keeps it and the preview reads it.

import { useState } from "react"
import { Plus, Trash } from "@phosphor-icons/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { seasonLine, withSeasons } from "@/lib/data/scheme-seasons"
import { SEASON_FREQUENCIES, type SeasonFrequency, type WeekRotation } from "@waste/domain/planning/vocabulary"
import { OFFERED_RECURRENCE_FREQUENCIES, RECURRENCE_FREQUENCY_LABELS } from "@waste/domain/route-schemes/recurrence"
import { seasonProblems, storedSeasonsFromValues, type StoredSchemeSeason } from "@waste/domain/route-schemes/scheme-seasons"
import { SEASONS_MAX } from "@waste/domain/route-schemes/seasons"

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
/** The days each month offers: a year without a leap day, the one a season is read in. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** The cadences a season is offered at: the forms' own, less daily. */
const SEASON_CADENCES = OFFERED_RECURRENCE_FREQUENCIES.filter((frequency): frequency is SeasonFrequency => (SEASON_FREQUENCIES as readonly string[]).includes(frequency))

const pad = (value: number) => String(value).padStart(2, "0")

function MonthDayPicker({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  const [month, day] = value.split("-").map(Number)
  const days = MONTH_DAYS[(month || 1) - 1]
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Select value={String(month)} onValueChange={(next) => onChange(`${pad(Number(next))}-${pad(Math.min(day, MONTH_DAYS[Number(next) - 1]))}`)}>
          <SelectTrigger id={id} className="w-36" aria-label={`${label}: month`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((name, index) => (
              <SelectItem key={name} value={String(index + 1)}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(day)} onValueChange={(next) => onChange(`${pad(month)}-${pad(Number(next))}`)}>
          <SelectTrigger className="w-20" aria-label={`${label}: day`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: days }, (_, index) => (
              <SelectItem key={index + 1} value={String(index + 1)}>
                {index + 1}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

/** A new season's starting values, numbered after the others: May to September, weekly. */
const blankSeason = (count: number): StoredSchemeSeason => ({ name: `Season ${count + 1}`, startsOn: "05-01", endsOn: "10-01", frequency: "weekly", weekRotation: null })

function SeasonsDialog({ record, onClose }: { record: BusinessRecord; onClose: () => void }) {
  const { upsertRecord } = useBusinessRecordStore()
  const [drafts, setDrafts] = useState<StoredSchemeSeason[]>(() => storedSeasonsFromValues(record.submittedValues))
  const [saving, setSaving] = useState(false)
  const problems = seasonProblems(drafts)
  const change = (index: number, patch: Partial<StoredSchemeSeason>) => setDrafts((current) => current.map((season, n) => (n === index ? { ...season, ...patch } : season)))

  const save = () => {
    setSaving(true)
    const seasons = drafts.map((season) => ({ ...season, name: season.name.trim() }))
    whenSaved(
      upsertRecord("route-studio", "schemes", withSeasons(record, seasons)),
      () => {
        toast.success(seasons.length === 0 ? "Seasons cleared" : "Seasons saved", {
          description: seasons.length === 0 ? `${record.name} runs at its own cadence all year.` : `${record.name} runs at each season's cadence inside it, and at its own outside.`,
        })
        onClose()
      },
      () => setSaving(false),
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Seasons</DialogTitle>
          <DialogDescription>
            Each season is a stretch of every year in which the scheme serves its service days at another cadence. A season runs from its first day to its last, over the new year where it ends before it starts. Outside every season the scheme runs at its own cadence.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {drafts.length === 0 && <p className="text-sm text-muted-foreground">No seasons: the scheme runs at its own cadence all year.</p>}
          {drafts.map((season, index) => (
            <fieldset key={index} className="space-y-3 rounded-lg border border-border/60 p-3">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label htmlFor={`season-${index}-name`}>Name</Label>
                  <Input id={`season-${index}-name`} value={season.name} onChange={(event) => change(index, { name: event.target.value })} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${season.name || "season"}`} onClick={() => setDrafts((current) => current.filter((_, n) => n !== index))}>
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-4">
                <MonthDayPicker id={`season-${index}-from`} label="First day" value={season.startsOn} onChange={(startsOn) => change(index, { startsOn })} />
                {/* The form names the last day in, the record the first day out (ADR-0005). */}
                <MonthDayPicker id={`season-${index}-to`} label="Last day" value={lastDayOf(season.endsOn)} onChange={(last) => change(index, { endsOn: dayAfter(last) })} />
              </div>
              <div className="flex flex-wrap gap-4">
                <div className="space-y-1">
                  <Label htmlFor={`season-${index}-cadence`}>Cadence</Label>
                  <Select value={season.frequency} onValueChange={(frequency) => change(index, { frequency: frequency as SeasonFrequency, weekRotation: frequency === "every-2-weeks" ? (season.weekRotation ?? "odd") : null })}>
                    <SelectTrigger id={`season-${index}-cadence`} className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SEASON_CADENCES.map((frequency) => (
                        <SelectItem key={frequency} value={frequency}>
                          {RECURRENCE_FREQUENCY_LABELS[frequency]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {season.frequency === "every-2-weeks" && (
                  <div className="space-y-1">
                    <Label htmlFor={`season-${index}-rotation`}>Week rotation</Label>
                    <Select value={season.weekRotation ?? "odd"} onValueChange={(weekRotation) => change(index, { weekRotation: weekRotation as WeekRotation })}>
                      <SelectTrigger id={`season-${index}-rotation`} className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="odd">Odd ISO weeks</SelectItem>
                        <SelectItem value="even">Even ISO weeks</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </fieldset>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={drafts.length >= SEASONS_MAX} onClick={() => setDrafts((current) => [...current, blankSeason(current.length)])}>
            <Plus className="h-4 w-4" />
            Add season
          </Button>
          {problems.length > 0 && (
            <ul role="alert" className="list-disc space-y-1 pl-4 text-xs text-destructive">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={problems.length > 0 || saving} onClick={save}>
            Save seasons
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The calendar year's days in order, `mm-dd`, for the day before and after a month-day. */
const YEAR = MONTH_DAYS.flatMap((days, month) => Array.from({ length: days }, (_, day) => `${pad(month + 1)}-${pad(day + 1)}`))
const lastDayOf = (endsOn: string) => YEAR[(YEAR.indexOf(endsOn) + YEAR.length - 1) % YEAR.length]
const dayAfter = (last: string) => YEAR[(YEAR.indexOf(last) + 1) % YEAR.length]

/** The Seasons card of the scheme's Details tab: the set as it stands, and its editor where the scheme may be edited. */
export function SchemeSeasonsCard({ record, frequency, canEdit }: { record: BusinessRecord; frequency: string | undefined; canEdit: boolean }) {
  const [open, setOpen] = useState(false)
  const seasons = storedSeasonsFromValues(record.submittedValues)
  const daily = frequency === "daily"
  return (
    <section className="space-y-2 rounded-xl border border-border/60 p-4" aria-labelledby="scheme-seasons">
      <div className="flex items-center justify-between gap-2">
        <h3 id="scheme-seasons" className="text-sm font-semibold">
          Seasons
        </h3>
        {canEdit && !daily && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            Edit seasons
          </Button>
        )}
      </div>
      {daily ? (
        <p className="text-xs text-muted-foreground">A daily scheme serves every day all year and has no seasons.</p>
      ) : seasons.length === 0 ? (
        <p className="text-xs text-muted-foreground">None: the scheme runs at its own cadence all year.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {seasons.map((season) => (
            <li key={season.name}>{seasonLine(season)}</li>
          ))}
          <li className="text-xs text-muted-foreground">Outside these, the scheme&apos;s own cadence.</li>
        </ul>
      )}
      {open && <SeasonsDialog record={record} onClose={() => setOpen(false)} />}
    </section>
  )
}
