/**
 * Issue 380: config/local/user.yml was written in place (empty, then
 * filled), so a reader in between got half a file: CI saw a test read
 * "er-engineer preferences …". A reader in another process loops
 * (read + parse) while writeUserConfig rewrites a large body many times; it
 * must never see an empty, missing or partial file. Temp install root;
 * invented values only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type DenConfig = typeof import("../../src/shared/den-config.js");
let cfg: DenConfig;
let tmp = "";
let root = "";
let saved: string | undefined;

const USER_FILE = () => path.join(root, "config", "local", "user.yml");
const ROWS = 4000;
const WRITES = 1500;

/** A large body; `round` changes it so every write is a real rewrite. */
const body = (round: number) =>
  ({
    pad: Array.from(
      { length: ROWS },
      (_, i) => `row-${i}-${round}-abcdefghijklmnopqrstuvwxyz`,
    ),
    last: "complete",
  }) as unknown as Parameters<DenConfig["writeUserConfig"]>[0];

// The reader: plain CommonJS so it starts fast and runs on its own. It
// reads until the stop file appears, then prints its counts. Every read is
// checked whole (header and last line); every 10th is also parsed, so reads
// stay quick and land inside the writer's window often.
const READER = `
const fs = require("fs");
const yaml = require(process.argv[2]);
const file = process.argv[3], stop = process.argv[4], rows = Number(process.argv[5]);
let reads = 0, bad = 0, sample = "";
process.stdout.write("ready\\n");
while (!fs.existsSync(stop)) {
  reads++;
  let ok = false, raw = "";
  try {
    raw = fs.readFileSync(file, "utf-8");
    ok = raw.startsWith("# Per-engineer") && raw.endsWith("last: complete\\n");
    if (ok && reads % 10 === 0) {
      const v = yaml.parse(raw);
      ok = !!v && v.last === "complete" && Array.isArray(v.pad) && v.pad.length === rows;
    }
  } catch (e) { raw = raw || String(e); }
  if (!ok) { bad++; if (!sample) sample = raw.slice(0, 60); }
}
process.stdout.write(JSON.stringify({ reads, bad, sample }) + "\\n");
`;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-380-")));
  root = path.join(tmp, "den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  // Anchor BEFORE importing: den-config freezes its paths at load.
  saved = process.env.DEN_ROOT;
  process.env.DEN_ROOT = root;
  cfg = await import("../../src/shared/den-config.js");
});

afterAll(() => {
  if (saved === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeUserConfig under a concurrent reader (#380)", () => {
  it("a reader in another process never sees a partial or empty user.yml", async () => {
    cfg.writeUserConfig(body(0));
    const script = path.join(tmp, "reader.cjs");
    fs.writeFileSync(script, READER);
    const stop = path.join(tmp, "stop");
    const yamlPath = path.join(process.cwd(), "node_modules", "yaml");
    const kid = spawn(
      process.execPath,
      [script, yamlPath, USER_FILE(), stop, String(ROWS)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    kid.stderr.on("data", (d: Buffer) => (err += d.toString()));
    await new Promise<void>((resolve, reject) => {
      kid.on("error", reject);
      kid.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("ready\n")) resolve();
      });
    });
    for (let i = 1; i <= WRITES; i++) cfg.writeUserConfig(body(i));
    fs.writeFileSync(stop, "");
    const code = await new Promise<number | null>((r) => kid.on("exit", r));
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const line = out.split("\n").find((l) => l.startsWith("{"));
    const res = JSON.parse(line ?? "{}") as {
      reads: number;
      bad: number;
      sample: string;
    };
    expect(res.reads).toBeGreaterThan(0);
    expect({ bad: res.bad, sample: res.sample }).toEqual({
      bad: 0,
      sample: "",
    });
    expect(res.reads).toBeGreaterThan(WRITES);
    // The last write is the one on disk, and no temp file is left over.
    expect(cfg.readUserConfig()).toEqual(body(WRITES));
    expect(fs.readdirSync(path.dirname(USER_FILE()))).toEqual(["user.yml"]);
  }, 120_000);
});
