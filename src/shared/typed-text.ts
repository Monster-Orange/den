/**
 * Text Den types into an agent's terminal is plain text. A line break is
 * a newline (CR, CRLF, LS and PS become one); a tab stays; every other
 * control character (C0, DEL, C1), every bidi override, isolate or
 * direction mark and every zero-width character is dropped, so nothing in the text can act as a key (Enter, ESC sequences,
 * ^C) or reorder what the agent reads.
 */
const BREAKS = /\r\n?|[\u2028\u2029]/g;
// Control characters and bidi controls. Intentional.
const CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff\u061c]/g;

export function plainText(v: string): string {
  return v.replace(BREAKS, "\n").replace(CONTROLS, "");
}
