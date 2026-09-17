// The answer to `GET /healthz`: the API is up and this is its clock. Load
// balancers and uptime checks read the status; the clock lets a client spot a
// server whose time has drifted. Nothing about dependencies yet: the API has
// none until the Data step, and a readiness check is a separate route then.
import * as z from "zod"

import { IsoDateTime } from "./dates"

export const HealthResponse = z.object({
  status: z.literal("ok"),
  time: IsoDateTime,
})
export type HealthResponse = z.infer<typeof HealthResponse>
