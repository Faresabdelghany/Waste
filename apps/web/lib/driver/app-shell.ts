// The Driver App's app shell on the page's side (O25 of #290): the service
// worker over /driver (public/driver-sw.js) registered from the provider, and
// told what each screen has loaded — its own path and the build's static
// files it fetched — so the phone opens the app with no signal. A production
// build only: the development server's files are neither named by their
// content nor stable, and a worker over them would serve yesterday's code.

/** The worker's script and the pages it answers for. */
export const SHELL_SCRIPT = "/driver-sw.js"
export const SHELL_SCOPE = "/driver"

/** What a page tells the worker to keep: its own path, then the build's static files it loaded, each once. */
export function shellUrls(pathname: string, resources: readonly string[], origin: string): string[] {
  const statics = resources.filter((resource) => {
    try {
      const url = new URL(resource, origin)
      return url.origin === origin && url.pathname.startsWith("/_next/static/")
    } catch {
      return false
    }
  })
  return [...new Set([pathname, ...statics])]
}

type ShellScope = {
  navigator: { serviceWorker?: Pick<ServiceWorkerContainer, "register" | "getRegistration"> }
  location: Pick<Location, "pathname" | "origin">
  performance: Pick<Performance, "getEntriesByType">
}

/** Registers the worker where the browser has one, in a production build, and tells it what this page loaded; a failure leaves the app working online, as it always has. */
export async function registerShell(scope: ShellScope, enabled: boolean, log: (message: string, cause?: unknown) => void = console.warn): Promise<void> {
  if (!enabled || scope.navigator.serviceWorker === undefined) return
  try {
    await scope.navigator.serviceWorker.register(SHELL_SCRIPT, { scope: SHELL_SCOPE })
  } catch (error) {
    log("the Driver App's offline shell could not be registered", error)
    return
  }
  await keepShell(scope, enabled)
}

/**
 * Tells the shell's worker what this screen has loaded. Asked of the
 * registration, never `serviceWorker.ready`: a tab that came to /driver from
 * the sign-in page inside the app is no page of the worker's scope until it
 * is loaded again, and `ready` would never answer it; the worker keeps the
 * files all the same, for that next load. Nothing where none is registered.
 */
export async function keepShell(scope: ShellScope, enabled: boolean): Promise<void> {
  if (!enabled || scope.navigator.serviceWorker === undefined) return
  const registration = await scope.navigator.serviceWorker.getRegistration(SHELL_SCOPE)
  const worker = registration?.active ?? registration?.waiting ?? registration?.installing
  if (worker == null) return
  const resources = scope.performance.getEntriesByType("resource").map((entry) => entry.name)
  worker.postMessage({ type: "keep", urls: shellUrls(scope.location.pathname, resources, scope.location.origin) })
}

/** Whether this build keeps a shell: production only. */
export const SHELL_ENABLED = process.env.NODE_ENV === "production"
