// Drives src/ui/cli/spinner.ts with real ora (ESM-only, so not under Jest)
// on a fake terminal: argv[2] = columns ("none" for undefined), argv[3] =
// "tty" or "pipe". Prints {bytes, escapes, spinning, out} as JSON. Output
// past LIMIT bytes, or 10000 redraws, means the spinner is looping: the
// stream throws.
import { Writable } from "node:stream";

const LIMIT = 64 * 1024;
const [colsArg, ttyArg, modulePath] = process.argv.slice(2);
const { spinner } = await import(modulePath);

let out = "";
const stream = new Writable({
  write(chunk, _enc, cb) {
    out += chunk.toString();
    if (out.length > LIMIT)
      throw new Error(`unbounded output (${LIMIT}+ bytes)`);
    cb();
  },
});
stream.isTTY = ttyArg === "tty";
stream.columns = colsArg === "none" ? undefined : Number(colsArg);
// What ora calls to redraw a TTY: counted, since a spinner that loops on
// clearing lines may never write.
let redraws = 0;
const redraw = () => {
  if (++redraws > 10_000) throw new Error("unbounded redraws (10000+)");
  return true;
};
Object.assign(stream, {
  cursorTo: redraw,
  clearLine: redraw,
  moveCursor: redraw,
});

const s = spinner("Checking service health...", stream);
s.start();
s.text = "Checking service health (2/3)...";
s.succeed("Healthy");
process.stdout.write(
  JSON.stringify({
    bytes: out.length,
    escapes: /\u001b\[/.test(out),
    spinning: s.isSpinning,
    out,
  }),
);
