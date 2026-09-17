// The process entry: read the environment, bind the app, stop cleanly on the
// signals a host sends. Everything with behaviour lives in the modules this
// file composes, and is tested there.
import { createApp } from "./app"
import { parseEnv } from "./env"
import { listen } from "./listen"

const env = parseEnv(process.env)
const listening = await listen(createApp(), { host: env.HOST, port: env.PORT })
console.log(`@waste/api listening on ${listening.url}`)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void listening.close().then(() => process.exit(0))
  })
}
