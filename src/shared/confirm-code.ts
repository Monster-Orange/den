/**
 * SEC-2a: the short codes people read and type, in Crockford's base32.
 * Pure helpers, shared by the CLI (`web login` makes the confirmation
 * code) and the server (login-waits.ts checks it; pair-requests.ts makes
 * pairing codes), so the CLI imports no server module.
 */
import { randomInt } from "crypto";

/** Crockford's base32: no I, L, O or U. */
export const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A `web login` confirmation code's length, without its dash. */
export const CONFIRM_CODE_LEN = 8;

/** A fresh confirmation code: `ABCD-EFGH` (Crockford base32, 40 bits). */
export function newConfirmCode(
  rand: (n: number) => number = randomInt,
): string {
  let s = "";
  for (let i = 0; i < CONFIRM_CODE_LEN; i++) s += PAIR_ALPHABET[rand(32)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** A typed confirmation code: any case, dashes and spaces ignored, O as 0, I and L as 1. */
export function normalizeConfirmCode(input: string): string | null {
  const s = String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== CONFIRM_CODE_LEN) return null;
  for (const c of s) if (!PAIR_ALPHABET.includes(c)) return null;
  return s;
}
