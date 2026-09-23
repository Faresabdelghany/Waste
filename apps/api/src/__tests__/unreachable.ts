// Two ways a database is down, as loopback TCP facts: a port nobody listens
// on, where the connection is refused at once, and a server that accepts and
// never says a word, where the connection hangs until someone gives up. The
// readiness probe must turn both into a 503, the second one within its bound.
import { once } from "node:events"
import net from "node:net"

/** A URL at a loopback port that was just released, so connecting to it is refused. */
export async function refusedUrl(): Promise<string> {
  const server = net.createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as net.AddressInfo
  server.close()
  await once(server, "close")
  return `postgresql://nobody:nobody@127.0.0.1:${port}/none`
}

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
