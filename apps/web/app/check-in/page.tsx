import { CheckInApp } from "@/components/waste/check-in/check-in-app"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

/** The recycling centre's check-in (#393): the Site attendant's phone-first page. */
export default function CheckInPage() {
  return <CheckInApp />
}
