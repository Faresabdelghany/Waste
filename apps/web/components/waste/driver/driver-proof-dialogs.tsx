"use client"

// The Driver App's photos and signatures (O1 of #290): the photo field an
// exception's form carries — the camera, or the gallery where a phone offers
// it, drawn to fit and shown before it is sent — a photo of a stop on its
// own where the deployment turns it on, and the signature pad. The bytes are
// the Command Queue's from the tap until Storage has them
// (lib/driver/driver-app.ts); a refusal comes back as the stop's sentence.
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type PointerEvent } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ProofBytes } from "@/lib/driver/commands"
import { dataUrlOf, photoOf, signatureOf } from "@/lib/driver/proof-images"

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void }

/** A photo to send with the form, or none: taken, then shown with Remove until the form is sent. */
export function PhotoField({ photo, onPhoto, optional = true }: { photo: ProofBytes | null; onPhoto: (photo: ProofBytes | null) => void; optional?: boolean }) {
  const id = useId()
  const [reading, setReading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const preview = useMemo(() => (photo === null ? null : dataUrlOf(photo)), [photo])
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (file === undefined) return
    setReading(true)
    setProblem(null)
    try {
      onPhoto(await photoOf(file))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "This photo could not be read; take another")
    } finally {
      setReading(false)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{optional ? "Photo (optional)" : "Photo"}</Label>
      {preview === null ? (
        <Input id={id} type="file" accept="image/*" capture="environment" className="h-11" disabled={reading} onChange={(event) => void choose(event)} />
      ) : (
        <div className="flex items-center gap-3">
          {/* The phone's own bytes, which next/image has nothing to optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="The photo to send" className="h-20 w-20 rounded-md border object-cover" />
          <Button type="button" variant="outline" size="sm" onClick={() => onPhoto(null)}>
            Remove photo
          </Button>
        </div>
      )}
      {reading && <p className="text-sm text-muted-foreground">Preparing the photo…</p>}
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}

/** A photo of a stop on its own, where the deployment offers one at every stop. */
export function PhotoDialog({ open, onOpenChange, title, description, onConfirm }: DialogProps & { title: string; description: string; onConfirm: (photo: ProofBytes) => void }) {
  const [photo, setPhoto] = useState<ProofBytes | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (photo === null) return
    onConfirm(photo)
    onOpenChange(false)
    setPhoto(null)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <PhotoField photo={photo} onPhoto={setPhoto} optional={false} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11" disabled={photo === null}>
              Send photo
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const INK = "#111827"
const PAPER = "#ffffff"

/** A blank sheet the size the pad is drawn at, in the screen's own pixels so a stroke stays sharp. */
function blankSheet(pad: HTMLCanvasElement | null) {
  if (pad === null) return
  const ratio = window.devicePixelRatio || 1
  const { width, height } = pad.getBoundingClientRect()
  pad.width = Math.max(1, Math.round(width * ratio))
  pad.height = Math.max(1, Math.round(height * ratio))
  const context = pad.getContext("2d")
  if (context === null) return
  context.fillStyle = PAPER
  context.fillRect(0, 0, pad.width, pad.height)
  context.strokeStyle = INK
  context.lineWidth = 2.5 * ratio
  context.lineCap = "round"
  context.lineJoin = "round"
}

/** Signed with a finger, a stylus or the mouse: the canvas as PNG once the person has drawn on it, Clear to begin again. */
export function SignatureDialog({ open, onOpenChange, title, description, onConfirm }: DialogProps & { title: string; description: string; onConfirm: (signature: ProofBytes) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Mounted with each opening, so every signature starts on a blank sheet. */}
        <SignatureForm
          onCancel={() => onOpenChange(false)}
          onSigned={(signature) => {
            onConfirm(signature)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function SignatureForm({ onCancel, onSigned }: { onCancel: () => void; onSigned: (signature: ProofBytes) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [signed, setSigned] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => blankSheet(canvas.current), [])

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const pad = event.currentTarget
    const box = pad.getBoundingClientRect()
    return { x: ((event.clientX - box.left) * pad.width) / box.width, y: ((event.clientY - box.top) * pad.height) / box.height }
  }
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    last.current = point(event)
  }
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    const from = last.current
    const context = event.currentTarget.getContext("2d")
    if (from === null || context === null) return
    const to = point(event)
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
    last.current = to
    setSigned(true)
  }
  const up = () => {
    last.current = null
  }
  const clear = () => {
    blankSheet(canvas.current)
    setSigned(false)
    setProblem(null)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (canvas.current === null || !signed) return
    try {
      onSigned(await signatureOf(canvas.current))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The signature could not be kept; sign again")
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Sign here</p>
        <canvas ref={canvas} aria-label="Signature pad" className="h-48 w-full touch-none rounded-md border bg-white" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {problem !== null && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="outline" onClick={clear} disabled={!signed}>
          Clear
        </Button>
        <Button type="submit" className="h-11" disabled={!signed}>
          Save signature
        </Button>
      </div>
    </form>
  )
}
