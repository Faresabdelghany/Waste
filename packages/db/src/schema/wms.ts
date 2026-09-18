// The domain schema. Everything the contexts own lives under `wms`, which is
// never in Supabase's exposed schemas and never granted to the Data API roles
// (ADR-0001): PostgREST and Realtime cannot reach it by construction, and the
// Hono API is the only way in.
import { pgSchema } from "drizzle-orm/pg-core"

export const wms = pgSchema("wms")
