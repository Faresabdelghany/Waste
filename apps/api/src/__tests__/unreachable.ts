// Two ways a database is down, as loopback TCP facts: a port nobody listens
// on, where the dial is refused at once, and a server that accepts and never
// says a word, where the dial hangs until someone gives up. The readiness
// probe must turn both into a 503, the second one within its bound.
import { once } from "node:events"
import net from "node:net"

/**
 * A URL at loopback port 1 (tcpmux): binding it needs root and nothing binds
 * it, so a dial is refused at once. A port released a moment ago would do the
 * same until another process took it; this one stays free.
 */
export const REFUSED_URL = "postgresql://nobody:nobody@127.0.0.1:1/none"

export type SilentServer = {
  url: string
  /** Destroys every accepted connection and stops listening. */
  close: () => Promise<void>
}

/** A server that accepts connections and never answers them. */
export async function silentServer(): Promise<SilentServer> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as net.AddressInfo
  return {
    url: `postgresql://nobody:nobody@127.0.0.1:${port}/none`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      server.close()
      await once(server, "close")
    },
  }
}
