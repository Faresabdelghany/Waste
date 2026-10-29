"use client"

// Scan container (O19 of #290): the code read off a bin — by the phone's
// camera where the browser has a `BarcodeDetector`, else typed off the label
// or a hand-held RFID reader's screen — asked of the door, and the door's
// answer said. A code naming this stop's container sends the arrival with
// it; out of reach, the arrival may be queued with the code and the server
// judges it when the phone is back (lib/driver/container-scan.ts).
import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { Barcode, Camera } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { barcodeDetectorOf, binDetector, firstCode, scanVerdict } from "@/lib/driver/container-scan"
import type { IdentifyAnswer } from "@/lib/driver/driver-app"

type Method = "camera" | "typed"

/** How often a camera frame is looked at: a few times a second finds a label held still, without heating the phone. */
const FRAME_MS = 300

type ScanDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  stopId: string
  numberOf: (pickupId: string) => number | undefined
  identify: (code: string) => Promise<IdentifyAnswer>
  /** The arrival with the code: sent once the door named this stop's container, or queued for the server to judge. */
  onConfirm: (identification: { code: string; method: Method }) => void
}

export function ScanDialog({ open, onOpenChange, title, description, stopId, numberOf, identify, onConfirm }: ScanDialogProps) {
  const id = useId()
  const [code, setCode] = useState("")
  const [checking, setChecking] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  /** The code the door could not be asked about, which may be queued. */
  const [unchecked, setUnchecked] = useState<{ code: string; method: Method } | null>(null)
  const [scanning, setScanning] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const [detector] = useState(() => (typeof window === "undefined" ? null : barcodeDetectorOf(window as unknown as Parameters<typeof barcodeDetectorOf>[0])))

  const reset = () => {
    setCode("")
    setChecking(false)
    setSaid(null)
    setUnchecked(null)
    setScanning(false)
  }
  const close = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const check = async (read: string, method: Method) => {
    const trimmed = read.trim()
    if (trimmed === "" || checking) return
    setScanning(false)
    setChecking(true)
    setSaid(null)
    setUnchecked(null)
    const answer = await identify(trimmed)
    setChecking(false)
    if (answer.status === "unreachable") {
      setSaid(`Can't reach the server to check ${trimmed}.`)
      setUnchecked({ code: trimmed, method })
      return
    }
    if (answer.status === "refused") {
      setSaid(answer.sentence)
      return
    }
    const verdict = scanVerdict(answer.answer, stopId, numberOf)
    if (verdict.kind === "this-stop") {
      onConfirm({ code: trimmed, method })
      close(false)
      return
    }
    setSaid(verdict.sentence)
  }

  // The latest `check`, for the camera's loop, which is started only by the toggle.
  const checkLatest = useRef(check)
  useEffect(() => {
    checkLatest.current = check
  })

  // The camera runs only while Scan with camera is on, and stops with the dialog.
  useEffect(() => {
    if (!scanning || detector === null) return
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
        if (stopped || video.current === null) return
        video.current.srcObject = stream
        await video.current.play()
        const reader = await binDetector(detector)
        const look = async () => {
          if (stopped || video.current === null) return
          try {
            const found = firstCode(await reader.detect(video.current))
            if (found !== null) {
              setCode(found)
              void checkLatest.current(found, "camera")
              return
            }
          } catch {
            // A frame not ready yet; the next one is looked at.
          }
          timer = setTimeout(() => void look(), FRAME_MS)
        }
        void look()
      } catch {
        setScanning(false)
        setSaid("The camera could not be opened. Type the code instead.")
      }
    })()
    return () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
  }, [scanning, detector])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void check(code, "typed")
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {detector !== null && (
            <div className="flex flex-col gap-2">
              {scanning && <video ref={video} muted playsInline aria-label="Camera" className="aspect-video w-full rounded-lg bg-muted object-cover" />}
              <Button type="button" variant="outline" className="h-11" disabled={checking} onClick={() => setScanning((on) => !on)}>
                <Camera aria-hidden />
                {scanning ? "Stop the camera" : "Scan with camera"}
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-code`}>Barcode, tag or label</Label>
            <Input id={`${id}-code`} value={code} autoComplete="off" autoCapitalize="characters" maxLength={200} onChange={(event) => setCode(event.target.value)} />
          </div>
          {said !== null && (
            <p role="status" className="text-sm">
              {said}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            {unchecked !== null ? (
              <Button
                type="button"
                className="h-11"
                onClick={() => {
                  onConfirm(unchecked)
                  close(false)
                }}
              >
                Send; the server checks it
              </Button>
            ) : (
              <Button type="submit" className="h-11" disabled={checking || code.trim() === ""}>
                <Barcode aria-hidden />
                {checking ? "Checking…" : "Check code"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
