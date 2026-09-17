// Binding the app to a TCP port on Node. A promise so the caller learns the
// bound address (port 0 means "any free port", which the tests use) and gets a
// close that resolves once the server has let go of the port.
import { serve } from "@hono/node-server"
import type { Hono } from "hono"
import type { AddressInfo } from "node:net"

export type Listening = {
  /** `http://host:port` as bound, ready to prefix a path. */
  url: string
  /** Stops accepting connections and resolves when the port is released. */
  close: () => Promise<void>
}

const hostOf = (info: AddressInfo) => (info.family === "IPv6" ? `[${info.address}]` : info.address)

export function listen(app: Hono, { host, port }: { host: string; port: number }): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      resolve({
        url: `http://${hostOf(info)}:${info.port}`,
        close: () =>
          new Promise<void>((closed, failed) => {
            server.close((error) => (error ? failed(error) : closed()))
          }),
      })
    })
    server.once("error", reject)
  })
}
