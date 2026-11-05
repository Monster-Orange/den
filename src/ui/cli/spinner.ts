/**
 * The CLI's progress spinners (ora).
 *
 * Spinners are progress, not diagnostics: on a terminal they animate on
 * stderr as usual; piped (CI, scripts) their lines go to stdout so stderr
 * carries only real warnings and errors.
 *
 * They animate only on a terminal with a known, non-zero width. ora
 * divides each line's width by the column count to know how many lines to
 * clear before the next frame: on a pty that reports 0 columns (one nobody
 * sized, as agent shells and some CI runners give) that is Infinity and the
 * spinner clears lines forever. Without a usable terminal a spinner prints
 * plain lines instead: its text once on start, and the final line.
 */
import oraSpinner, { type Ora } from "ora";

/** A stream as a spinner sees it: a TTY, maybe, with a width, maybe. */
export interface SpinnerStream extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
}

/** Whether a spinner can draw frames on `stream`. */
export function canAnimate(stream: SpinnerStream): boolean {
  return (
    stream.isTTY === true &&
    typeof stream.columns === "number" &&
    Number.isFinite(stream.columns) &&
    stream.columns > 0
  );
}

function defaultStream(): SpinnerStream {
  return process.stderr.isTTY ? process.stderr : process.stdout;
}

/** A spinner showing `text`, on stderr (a terminal) or stdout (piped). */
export function spinner(
  text: string,
  stream: SpinnerStream = defaultStream(),
): Ora {
  return oraSpinner({
    text,
    stream: stream as NodeJS.WritableStream,
    // Unset, ora decides (never under CI or TERM=dumb); false: plain lines.
    ...(canAnimate(stream) ? {} : { isEnabled: false }),
  });
}
