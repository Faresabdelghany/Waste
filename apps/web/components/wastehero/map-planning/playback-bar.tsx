"use client"

// Route stop playback bar (2026-09-16): the strip over the map that drives
// a replay of one dated route — play/pause, speed, a scrubber over the stops
// (native range: arrows, Home and End work), and the caption for the stop
// the vehicle is nearest: its order, label, planned and actual clock, and
// the delay between them where a completed route recorded one. The view
// owns the progress; lib/map-planning/playback.ts owns the arithmetic.

import { Pause, Play, X } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { formatShortDate } from "@/lib/map-planning/format"
import { formatDelay, stopDelay } from "@/lib/map-planning/playback"
import type { AreaRoute } from "@waste/domain/map-planning/routes"
import { cn } from "@/lib/utils"

import { StatusBadge } from "./status-badge"

export type PlaybackSpeed = 1 | 2 | 4
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [1, 2, 4]

export type PlaybackBarProps = {
  route: AreaRoute
  /** Fractional stop index, 0 at the first stop. */
  progress: number
  playing: boolean
  speed: PlaybackSpeed
  onTogglePlay: () => void
  onSpeedChange: (speed: PlaybackSpeed) => void
  onScrub: (progress: number) => void
  onClose: () => void
  className?: string
  style?: React.CSSProperties
}

export function PlaybackBar({
  route,
  progress,
  playing,
  speed,
  onTogglePlay,
  onSpeedChange,
  onScrub,
  onClose,
  className,
  style,
}: PlaybackBarProps) {
  const last = Math.max(0, route.stops.length - 1)
  const nearest = Math.min(last, Math.max(0, Math.round(progress)))
  const stop = route.stops[nearest]
  const delay = stop ? stopDelay(stop.planned, stop.actual) : null
  const times = stop
    ? [
        stop.planned ? `planned ${stop.planned}` : null,
        stop.actual ? `actual ${stop.actual}` : null,
        delay !== null ? formatDelay(delay) : null,
      ].filter(Boolean)
    : []

  return (
    <section
      aria-label={`Playback of route ${route.name}`}
      data-testid="playback-bar"
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-background/95 px-3 py-2.5 text-sm shadow-md backdrop-blur",
        className,
      )}
      style={style}
    >
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: route.color }} aria-hidden />
        <span className="truncate font-semibold">{route.name}</span>
        <StatusBadge status={route.status} />
        <span className="truncate text-xs text-muted-foreground">
          {route.date ? formatShortDate(route.date) : "Undated"}
          {route.vehicle ? ` · ${route.vehicle}` : ""}
          {route.driver ? ` · ${route.driver}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <div role="group" aria-label="Playback speed" className="flex items-center rounded-md border border-border p-0.5">
            {PLAYBACK_SPEEDS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === speed}
                onClick={() => onSpeedChange(option)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground hover:text-foreground",
                  option === speed && "bg-primary text-primary-foreground hover:text-primary-foreground",
                )}
              >
                {option}×
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close playback" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="default"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full"
          aria-label={playing ? "Pause" : "Play"}
          onClick={onTogglePlay}
          disabled={route.stops.length < 2}
        >
          {playing ? <Pause className="h-4 w-4" weight="fill" /> : <Play className="h-4 w-4" weight="fill" />}
        </Button>
        <input
          type="range"
          aria-label="Route progress"
          min={0}
          max={last}
          step={0.01}
          value={Math.min(last, Math.max(0, progress))}
          onChange={(event) => onScrub(Number(event.currentTarget.value))}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary"
          style={{ accentColor: route.color }}
          disabled={route.stops.length < 2}
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="playback-position">
          Stop {nearest + 1} of {route.stops.length}
        </span>
      </div>

      <p className="flex min-w-0 items-baseline gap-2 text-xs" data-testid="playback-caption">
        {stop ? (
          <>
            <span className="truncate font-medium text-foreground">
              {stop.index}. {stop.label}
            </span>
            <span className="shrink-0 text-muted-foreground">{stop.status}</span>
            <span
              className={cn(
                "ml-auto shrink-0 tabular-nums text-muted-foreground",
                delay !== null && delay > 0 && "text-amber-600 dark:text-amber-400",
                delay !== null && delay < 0 && "text-emerald-600 dark:text-emerald-400",
              )}
              data-testid="playback-times"
            >
              {times.length ? times.join(" · ") : "No times recorded"}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">This route has no stop positions to replay.</span>
        )}
      </p>
    </section>
  )
}
