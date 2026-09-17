// The process entry: read the environment, bind the app, stop on the signals
// a host sends. Everything with behaviour lives in the modules this file
// composes, and is tested there.
import { createApp } from "./app"
import { parseEnv } from "./env"
import { listen } from "./listen"

const env = parseEnv(process.env)
const listening = await listen(createApp(), { host: env.HOST, port: env.PORT })
console.log(`@waste/api listening on ${listening.url}`)

// close() is idempotent, so a signal delivered twice (a terminal Ctrl-C plus
// tsx's relay of it, or SIGINT followed by SIGTERM) joins the one shutdown
// instead of killing the process mid-drain; hence `on`, not `once`.
const shutdown = () => {
  listening.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
