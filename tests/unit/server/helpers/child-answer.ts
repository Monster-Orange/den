/**
 * Issue 695: a process this test can't wait on (an orphan, adopted by
 * init) leaves its answer in a file. The file can exist before its words
 * are in it (writeFileSync creates it, then writes), so "it exists" is not
 * "it is written". The child ends its answer with END; the reader waits
 * for END, and gives back the answer without it.
 */
import * as fs from "fs";

/** The line that ends a complete answer. */
export const END = "\n<<end>>\n";

/** JS source for a child: write `expr`'s text to `file`, then END. */
export function writeAnswerJs(file: string, expr: string): string {
  return `require("fs").writeFileSync(${JSON.stringify(file)},${expr}+${JSON.stringify(END)})`;
}

/** Waits until `file` holds a complete answer; the answer, without END. */
export async function readAnswer(
  file: string,
  timeoutMs = 20_000,
  what = "the child",
): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      /* not there yet */
    }
    if (text.endsWith(END)) return text.slice(0, -END.length);
    if (Date.now() > end) throw new Error(`${what} never answered`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
