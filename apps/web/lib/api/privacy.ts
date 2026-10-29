// A project's privacy policy on the wire (#291 C19): written whole through
// `PUT /projects/:id/privacy-policy`, under `edit` on `configure.privacy`, and
// read back with the project. The contract is a type here; a runtime zod
// import would land in every workspace route's bundle.
import type { PrivacyPolicy } from "@waste/contracts/organisation"

import { put, type ApiClient } from "./client"

/** The module whose `edit` writes a project's policy. */
export const PRIVACY_POLICY_MODULE = "configure.privacy"

/** Replaces the project's policy whole; answers it as it now stands. */
export function replacePrivacyPolicy(client: ApiClient, projectServerId: string, policy: PrivacyPolicy): Promise<PrivacyPolicy> {
  return put<PrivacyPolicy>(client, `/projects/${encodeURIComponent(projectServerId)}/privacy-policy`, policy)
}
