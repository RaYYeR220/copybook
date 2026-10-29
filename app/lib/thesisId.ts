/**
 * A thesis id as URLs carry it: a positive decimal with no leading zeros, at most nine digits. "01", "0" and "1e3"
 * are not ids, so every route (page, follow flow, card) answers one URL per thesis and a 404 for anything else.
 */
export function parseThesisId(raw: string): bigint | null {
  return /^[1-9][0-9]{0,8}$/.test(raw) ? BigInt(raw) : null;
}
