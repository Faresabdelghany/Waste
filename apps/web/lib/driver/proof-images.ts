// A photo's and a signature's bytes as the Driver App makes them (O1 of #290),
// before the Command Queue holds them until Storage has them. A phone's
// camera takes several megabytes; the photo is drawn again to fit 1600 px
// and sent as JPEG, a few hundred kilobytes, never more than the bucket
// takes (the contracts' `PROOF_OBJECT_MAX_BYTES`). A signature is the pad's
// canvas as PNG. The browser decodes and draws; nothing here reads the
// picture.
//
// On the Pilot a photo is taken with an exception — a skip, a failure, a
// problem — and a signature on its own; a photo of any stop is the
// deployment's setting, `NEXT_PUBLIC_DRIVER_STOP_PHOTOS`, off unless it is
// `true`, inlined by Next at build time and read by its literal name as
// app-version.ts reads its own.
import type { ProofBytes } from "./commands"

/** The longer edge a photo is drawn to fit. */
export const PHOTO_MAX_EDGE = 1600

/** The largest photo sent: the bucket's limit, spelled again so no zod reaches the browser, and held equal to it by a test. */
export const PHOTO_BYTES_MAX = 2 * 1024 * 1024

/** The JPEG qualities tried in turn until the photo fits. */
const PHOTO_QUALITIES = [0.8, 0.6, 0.4] as const

type Env = Readonly<Record<string, string | undefined>>

export function stopPhotosOf(env: Env): boolean {
  return env.NEXT_PUBLIC_DRIVER_STOP_PHOTOS?.trim() === "true"
}

/** Whether any stop offers a photo of its own, not only with an exception. */
export const STOP_PHOTOS: boolean = stopPhotosOf({ NEXT_PUBLIC_DRIVER_STOP_PHOTOS: process.env.NEXT_PUBLIC_DRIVER_STOP_PHOTOS })

/** A picture's size scaled to fit its longer edge within `maxEdge`, its shape kept; a smaller one as it is. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

const encoded = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("This phone could not encode the picture")) : resolve(blob)), type, quality)
  })

/** A photo the camera or the gallery handed over, drawn to fit and encoded as JPEG; throws a sentence for the screen where it cannot be read or will not fit. */
export async function photoOf(file: Blob): Promise<ProofBytes> {
  let bitmap: ImageBitmap
  try {
    // The photo's own orientation is applied by default, which a camera records rather than turning the pixels; an older Safari refuses the option that names it.
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error("This photo could not be read; take another")
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, PHOTO_MAX_EDGE)
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (context === null) throw new Error("This phone could not draw the photo")
    context.drawImage(bitmap, 0, 0, width, height)
    for (const quality of PHOTO_QUALITIES) {
      const blob = await encoded(canvas, "image/jpeg", quality)
      if (blob.size <= PHOTO_BYTES_MAX) return { extension: "jpg", contentType: "image/jpeg", bytes: await blob.arrayBuffer() }
    }
    throw new Error("This photo is too large to send; take another")
  } finally {
    bitmap.close()
  }
}

/** The bytes as a `data:` URL, for the screen to show what goes: no blob URL to revoke, which a remount in development would leave dangling. */
export function dataUrlOf({ contentType, bytes }: ProofBytes): string {
  const view = new Uint8Array(bytes)
  let binary = ""
  for (let start = 0; start < view.length; start += 0x8000) binary += String.fromCharCode(...view.subarray(start, start + 0x8000))
  return `data:${contentType};base64,${btoa(binary)}`
}

/** The signature pad's canvas as PNG. */
export async function signatureOf(canvas: HTMLCanvasElement): Promise<ProofBytes> {
  const blob = await encoded(canvas, "image/png")
  return { extension: "png", contentType: "image/png", bytes: await blob.arrayBuffer() }
}
