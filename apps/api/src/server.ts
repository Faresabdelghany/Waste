// The process entry: read the environment, open the database pool, bind the
// app, stop on the signals a host sends. Everything with behaviour lives in
// the modules this file composes, and is tested there.
//
// Opening the pool connects to nothing: postgres.js dials on the first query,
// so the process starts whether or not the database is up, and /readyz says
// which (a database that is down at boot is the same as one that goes down
// later, and both are the balancer's to route around). Shutdown is in order:
// the listener drains first, so a request in flight keeps its connection,
// then the pool closes.
import { createDb } from "@waste/db/client"

import { createApp } from "./app"
import { parseEnv } from "./env"
import { listen } from "./listen"

const env = parseEnv(process.env)
const database = createDb(env.DATABASE_URL)
const listening = await listen(createApp({ db: database }), { host: env.HOST, port: env.PORT })
console.log(`@waste/api listening on ${listening.url}`)

// close() is idempotent, so a signal delivered twice (a terminal Ctrl-C plus
// tsx's relay of it, or SIGINT followed by SIGTERM) joins the one shutdown
// instead of killing the process mid-drain; hence `on`, not `once`. The pool
// closes after the listener, whatever the listener's outcome, and its own
// close is idempotent too.
const shutdown = () => {
  listening
    .close()
    .finally(() => database.close())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error)
        process.exit(1)
      },
    )
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
