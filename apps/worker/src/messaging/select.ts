// The messaging provider switch (#291 C15), one environment setting read by
// env.ts as the routing provider's is (@waste/routing/select): unset or `log`
// is the log-only sender, which sends nothing and so is safe on the Pilot and
// in CI. No other provider exists yet — the owner's decision on #291 is the
// log-only sender until a card-free provider is verified — so any other name
// refuses the worker's start rather than fail every send.
import { LOG_ONLY_PROVIDER, LogOnlyProvider } from "./log-only"
import type { MessagingProvider } from "./provider"

export const MESSAGING_PROVIDER_VARIABLE = "MESSAGING_PROVIDER"

/** The provider the environment names; the log-only sender where it names none. */
export function messagingProviderFromEnv(name: string | undefined, log?: (line: string) => void): MessagingProvider {
  const named = name || LOG_ONLY_PROVIDER
  if (named === LOG_ONLY_PROVIDER) return new LogOnlyProvider(log)
  throw new Error(`${MESSAGING_PROVIDER_VARIABLE}=${named} names no provider here: "${LOG_ONLY_PROVIDER}", the log-only sender, is the only one until a card-free provider is verified (#291)`)
}
