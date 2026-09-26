// Binding the probes to a TCP port on Node, and letting go of it again — the
// API's listen.ts, unchanged but for this sentence. Node's own http server is
// used directly (through node-server's request listener,
// with its global Request/Response override switched off) so that closing is
// under our control: close() stops accepting, drops idle keep-alive
// connections at once, waits for requests in flight, and cuts whatever is
// still open when the grace period ends, so a stalled client cannot hold the
// process past its host's deadline. The port itself is released as soon as
// close() is called; the promise resolves when the last connection is gone.
import { getRequestListener } from "@hono/node-server"
import type { Hono } from "hono"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/** How long close() waits for requests in flight before cutting connections. */
export const SHUTDOWN_GRACE_MS = 5_000

export type ListenOptions = {
  host: string
  /** 0 asks the OS for a free port; the tests do. */
  port: number
  graceMs?: number
}

export type Listening = {
  /**
   * `http://host:port` as bound, ready to prefix a path. An IPv6 zone id
   * (`fe80::1%lo0`) has no URL spelling, which is why env.ts refuses one.
   */
  url: string
  /** The Node server, for anything that must reach the socket layer. */
  server: Server
  /** Idempotent: every call returns the one shutdown promise. */
  close: () => Promise<void>
}

const hostOf = (info: AddressInfo) => (info.family === "IPv6" ? `[${info.address}]` : info.address)

export async function listen(app: Hono, { host, port, graceMs = SHUTDOWN_GRACE_MS }: ListenOptions): Promise<Listening> {
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }))
  server.listen({ host, port })
  // Rejects if the server emits "error" first (EADDRINUSE, ENOTFOUND) and
  // removes both listeners once settled, so a later error is not swallowed.
  await once(server, "listening")
  const info = server.address() as AddressInfo

  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => server.closeAllConnections(), graceMs)
      server.close((error) => {
        clearTimeout(deadline)
        if (error) reject(error)
        else resolve()
      })
    }))

  return { url: `http://${hostOf(info)}:${info.port}`, server, close }
}
