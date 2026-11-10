// A token or a phrase as a sentence opens with it. A wire token as a status
// reads is `statusLabel` (lib/records/fields.ts), which spaces the token's
// words and capitalises them through this.

export const capitalised = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1)
