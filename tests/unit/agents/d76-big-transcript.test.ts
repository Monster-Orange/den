/**
 * D76: an agent's transcript of gigabytes never takes the list or the web
 * server down. Its helpers' states are read from its end only
 * (agents.helpers.read_max_mb, default 64 MB), then only what it appends;
 * what is kept from it shares no memory with the chunks read.
 *
 * A sparse transcript over 1 GB, a task notification in every 8 MB chunk,
 * read in a child with a 512 MB heap: once (`agents list`), and polled
 * while it grows (the web server). It must finish, and under 300 MB.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const ENGINE = path.resolve(__dirname, "../../..");
const LOADER = pathToFileURL(
  path.join(ENGINE, "node_modules/tsx/dist/loader.mjs"),
).href;
const DRIVER = path.join(__dirname, "helpers", "big-transcript-driver.mjs");
const MODULE = pathToFileURL(
  path.join(ENGINE, "src/shared/agents/claude-helpers.ts"),
).href;
const CHUNK = 8 * 1024 * 1024;
const CHUNKS = 150; // 1.2 GB
const MB = 1024 * 1024;

let dir = "";
let transcript = "";

/** A real tool-use id's length (a short one is copied, never a slice). */
const toolId = (k: number) => `toolu_01${String(k).padStart(22, "0")}`;

const note = (k: number) =>
  JSON.stringify({
    type: "user",
    message: {
      content: `<task-notification><tool-use-id>${toolId(k)}</tool-use-id><status>completed</status></task-notification>`,
    },
  });

function helper(id: string, toolUseId: string): void {
  const sub = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(sub, `agent-${id}.meta.json`),
    JSON.stringify({ toolUseId, requestShape: "background" }),
  );
  fs.writeFileSync(
    path.join(sub, `agent-${id}.jsonl`),
    JSON.stringify({
      type: "user",
      timestamp: new Date().toISOString(),
      message: { content: "go" },
    }) + "\n",
  );
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-d76-")));
  transcript = path.join(dir, "0a1b2c3d.jsonl");
  const fd = fs.openSync(transcript, "w");
  // Holes between the lines: one long "line" each, past the longest read.
  for (let k = 0; k < CHUNKS; k++) {
    const line = `\n${note(k)}\n`;
    fs.writeSync(fd, line, k * CHUNK + CHUNK - line.length - 1);
  }
  fs.ftruncateSync(fd, CHUNKS * CHUNK);
  fs.closeSync(fd);
  helper("recent", toolId(CHUNKS - 1));
  helper("early", toolId(0));
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function run(readMaxMb: string, polls: number, grow = false) {
  const r = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=512",
      "--import",
      LOADER,
      DRIVER,
      MODULE,
      transcript,
      readMaxMb,
      String(polls),
      grow ? "grow" : "",
    ],
    { encoding: "utf-8", timeout: 170_000, maxBuffer: 1 << 20 },
  );
  if (r.status !== 0)
    throw new Error(
      `driver exited ${r.status ?? r.signal}: ${(r.stderr ?? "").slice(-600)}`,
    );
  return JSON.parse(r.stdout) as { out: [string, string][]; peak: number };
}

describe("D76: a transcript of gigabytes", () => {
  it("agents list: one read, by default only its end; the latest helper's notification counts", () => {
    expect(fs.statSync(transcript).size).toBeGreaterThan(1024 * MB);
    const { out, peak } = run("default", 1);
    expect(Object.fromEntries(out)).toEqual({
      recent: "done",
      // Its notification is a gigabyte back: from its own files instead.
      early: "running",
    });
    expect(peak).toBeLessThan(300 * MB);
  }, 180_000);

  it("the web server: polled as it grows, it reads on and stays small", () => {
    const { out, peak } = run("default", 12, true);
    expect(Object.fromEntries(out).recent).toBe("done");
    expect(peak).toBeLessThan(300 * MB);
  }, 180_000);

  it("set to read all of it, it still finishes in a 512 MB heap (nothing kept pins a chunk)", () => {
    const { out } = run("4096", 1);
    expect(Object.fromEntries(out)).toEqual({ recent: "done", early: "done" });
  }, 180_000);
});
