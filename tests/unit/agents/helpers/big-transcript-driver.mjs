// D76: reads a big transcript's helpers in a child with a small heap, as
// `agents list` (one read) and the web server's polling (reads on as it
// grows) do. Prints the statuses and the memory it ended with.
import * as fs from "fs";

const [, , moduleUrl, transcript, readMaxMb, polls, grow] = process.argv;
const { readClaudeHelpers } = await import(moduleUrl);
const settings =
  readMaxMb === "default" ? {} : { readMaxMb: Number(readMaxMb) };
let out = [];
let peak = 0;
for (let i = 0; i < Number(polls); i++) {
  out = readClaudeHelpers(transcript, { settings, agentLive: true }).map(
    (h) => [h.id, h.status],
  );
  peak = Math.max(peak, process.memoryUsage().rss);
  // The agent writes on: 8 MB with a notification at its end.
  if (grow === "grow") {
    const fd = fs.openSync(transcript, "a");
    fs.writeSync(fd, "x".repeat(8 * 1024 * 1024 - 200) + "\n");
    fs.closeSync(fd);
  }
}
process.stdout.write(JSON.stringify({ out, peak }));
