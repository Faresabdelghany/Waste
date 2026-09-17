"use client"

// Saved selections (2026-09-16): the bookmark button in the selection
// toolbar and its menu — save the drawn shape under a name together with the
// filters and collection window it was drawn under, then load, rename, or
// delete it later. The list lives in the browser under one key
// (lib/map-planning/saved-selections.ts parses it tolerantly); loading is
// the page's job, since it owns filters, window, and selection.

import { useEffect, useRef, useState, type FormEvent } from "react"
import { BookmarkSimple, PencilSimple, Trash } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { businessFilterChips, type BusinessFilters } from "@waste/domain/business-filters"
import { formatShortDate } from "@/lib/map-planning/format"
import {
  SAVED_SELECTIONS_STORAGE_KEY,
  addSavedSelection,
  parseSavedSelections,
  removeSavedSelection,
  renameSavedSelection,
  serializeSavedSelections,
  type SavedSelection,
} from "@/lib/map-planning/saved-selections"
import { COLLECTION_WINDOW_LABELS, type CollectionWindow } from "@/lib/map-planning/schedule"
import type { SelectionShape } from "@/lib/map-planning/selection"
import { cn } from "@/lib/utils"

export type SavedSelectionsMenuProps = {
  /** The shape on the map right now — what "Save" would keep; null means nothing drawn. */
  shape: SelectionShape | null
  filters: BusinessFilters
  window: CollectionWindow
  onLoad: (saved: SavedSelection) => void
}

const SHAPE_LABELS: Readonly<Record<SelectionShape["kind"], string>> = {
  rectangle: "Rectangle",
  polygon: "Polygon",
}

const newId = () => `sel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function describe(shape: SelectionShape, filters: BusinessFilters, window: CollectionWindow): string {
  const chips = businessFilterChips(filters).length
  return [
    SHAPE_LABELS[shape.kind],
    COLLECTION_WINDOW_LABELS[window],
    chips ? `${chips} filter${chips === 1 ? "" : "s"}` : "No filters",
  ].join(" · ")
}

export function SavedSelectionsMenu({ shape, filters, window, onLoad }: SavedSelectionsMenuProps) {
  const [open, setOpen] = useState(false)
  const [selections, setSelections] = useState<SavedSelection[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const nameInput = useRef<HTMLInputElement>(null)

  // The list lives in the browser only; read it after mount so SSR and the
  // first client render agree, and never write before reading.
  useEffect(() => {
    try {
      setSelections(parseSavedSelections(globalThis.localStorage?.getItem(SAVED_SELECTIONS_STORAGE_KEY) ?? null))
    } catch {
      // A blocked store leaves the menu empty but usable for the session.
    }
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    try {
      globalThis.localStorage?.setItem(SAVED_SELECTIONS_STORAGE_KEY, serializeSavedSelections(selections))
    } catch {
      // Persistence blocked — the in-memory list still works.
    }
  }, [hydrated, selections])

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!shape || !draftName.trim()) return
    setSelections((current) =>
      addSavedSelection(current, { name: draftName, shape, filters, window }, { id: newId(), now: new Date().toISOString() }),
    )
    setDraftName("")
  }

  const startRename = (entry: SavedSelection) => {
    setEditingId(entry.id)
    setEditName(entry.name)
  }
  const commitRename = () => {
    if (editingId) setSelections((current) => renameSavedSelection(current, editingId, editName))
    setEditingId(null)
  }

  const load = (entry: SavedSelection) => {
    onLoad(entry)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-8 w-8"
              aria-label="Saved selections"
              data-testid="saved-selections-trigger"
            >
              <BookmarkSimple className="h-4 w-4" weight={selections.length ? "fill" : "regular"} />
              {selections.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                  {selections.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          Saved selections
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80 p-0 text-sm" aria-label="Saved selections">
        <form onSubmit={save} className="border-b border-border px-3 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Save current selection</p>
          <div className="flex items-center gap-2">
            <Input
              ref={nameInput}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder={shape ? "Name this selection" : "Draw a shape first"}
              aria-label="Selection name"
              disabled={!shape}
              className="h-8 text-sm"
            />
            <Button type="submit" size="sm" className="h-8" disabled={!shape || !draftName.trim()}>
              Save
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {shape
              ? `Keeps the ${describe(shape, filters, window).toLowerCase()}.`
              : "Select with a rectangle or polygon to save the shape with its filters and window."}
          </p>
        </form>
        <div className="px-3 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Saved</p>
          {selections.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing saved yet.</p>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto" data-testid="saved-selections">
              {selections.map((entry) => (
                <li key={entry.id} className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-accent/60" data-saved-selection={entry.id}>
                  {editingId === entry.id ? (
                    <Input
                      autoFocus
                      value={editName}
                      aria-label="New name"
                      className="h-7 flex-1 text-sm"
                      onChange={(event) => setEditName(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          commitRename()
                        }
                        if (event.key === "Escape") setEditingId(null)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => load(entry)}
                    >
                      <span className="block truncate font-medium">{entry.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {describe(entry.shape, entry.filters, entry.window)}
                        {entry.createdAt ? ` · ${formatShortDate(entry.createdAt.slice(0, 10))}` : ""}
                      </span>
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("h-7 w-7 text-muted-foreground", editingId === entry.id && "invisible")}
                    aria-label={`Rename ${entry.name}`}
                    onClick={() => startRename(entry)}
                  >
                    <PencilSimple className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${entry.name}`}
                    onClick={() => setSelections((current) => removeSavedSelection(current, entry.id))}
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
