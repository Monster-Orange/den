import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";
import {
  readClaudeHelpers,
  resetHelperCache,
} from "../../../src/shared/agents/claude-helpers.js";
import { helpersBlock } from "../../../src/shared/den-config.js";

const AGENTS = 90;
let dir = "";
const transcripts: string[] = [];
const toolId = (k: number) => `toolu_01${String(k).padStart(22, "0")}`;

function line(o: unknown): string {
  return JSON.stringify(o) + "\n";
}

function makeAgent(i: number): string {
  const t = path.join(dir, `agent${String(i).padStart(3, "0")}.jsonl`);
  let body = "";
  for (let k = 0; k < 200; k++)
    body += line({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(800) }] },
    });
  body += line({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolId(i * 10 + 1), content: "ok" },
      ],
    },
  });
  body += line({
    type: "user",
    message: {
      content: `<task-notification><tool-use-id>${toolId(i * 10 + 2)}</tool-use-id><status>completed</status></task-notification>`,
    },
  });
  fs.writeFileSync(t, body);
  const sub = path.join(t.replace(/\.jsonl$/, ""), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  for (const [id, tu] of [
    ["a", toolId(i * 10 + 1)],
    ["b", toolId(i * 10 + 2)],
    ["c", toolId(i * 10 + 3)],
  ]) {
    fs.writeFileSync(
      path.join(sub, `agent-${id}.meta.json`),
      JSON.stringify({ toolUseId: tu, requestShape: "background" }),
    );
    fs.writeFileSync(
      path.join(sub, `agent-${id}.jsonl`),
      line({
        type: "user",
        timestamp: new Date().toISOString(),
        message: { content: "go" },
      }),
    );
  }
  return t;
}

const realFs = createRequire(__filename)("fs") as {
  openSync: (...a: unknown[]) => number;
  readSync: (...a: unknown[]) => number;
};

function transcriptBytesReadDuring(fn: () => void): Map<string, number> {
  const fdPath = new Map<number, string>();
  const got = new Map<string, number>();
  const { openSync, readSync } = realFs;
  realFs.openSync = (p: unknown, ...rest: unknown[]) => {
    const fd = openSync(p, ...rest);
    fdPath.set(fd, String(p));
    return fd;
  };
  realFs.readSync = (fd: unknown, ...rest: unknown[]) => {
    const n = readSync(fd, ...rest);
    const p = fdPath.get(fd as number);
    if (p && transcripts.includes(p)) got.set(p, (got.get(p) ?? 0) + n);
    return n;
  };
  try {
    fn();
  } finally {
    realFs.openSync = openSync;
    realFs.readSync = readSync;
  }
  return got;
}

const list = (settings = {}) =>
  transcripts.map((t) =>
    readClaudeHelpers(t, { agentLive: true, settings }).map((h) => [
      h.id,
      h.status,
    ]),
  );
const total = (m: Map<string, number>) =>
  [...m.values()].reduce((a, b) => a + b, 0);

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1668-")));
  for (let i = 0; i < AGENTS; i++) transcripts.push(makeAgent(i));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetHelperCache());

describe("a session list over more agents than the old cache held (64)", () => {
  it("lists 90 agents twice: the second list reads no transcript bytes", () => {
    const first = transcriptBytesReadDuring(() => list());
    expect(first.size).toBe(AGENTS);
    const second = transcriptBytesReadDuring(() => list());
    expect(total(second)).toBe(0);
  });

  it("after one transcript grows, a list reads only its new bytes", () => {
    list();
    const extra = line({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: toolId(53), content: "late" },
        ],
      },
    });
    fs.appendFileSync(transcripts[5], extra);
    const again = transcriptBytesReadDuring(() => list());
    expect([...again]).toEqual([[transcripts[5], Buffer.byteLength(extra)]]);
  });

  it("the facts are the same from the cache as from a fresh read", () => {
    const warm = (list(), list());
    resetHelperCache();
    expect(list()).toEqual(warm);
  });
});

describe("agents.helpers.facts_cache_mb: the cache is bounded by bytes, least recently used out first", () => {
  it("defaults to 256 MB; a value is read; a bad one names the key", () => {
    expect(helpersBlock(undefined).factsCacheMb).toBe(256);
    expect(helpersBlock({ facts_cache_mb: 32 }).factsCacheMb).toBe(32);
    for (const bad of [0, -1, "big", 100_000])
      expect(() => helpersBlock({ facts_cache_mb: bad })).toThrow(
        "agents.helpers.facts_cache_mb",
      );
  });

  it("a budget too small for all: the ones used most recently stay", () => {
    const tiny = { factsCacheMb: 0.0007 };
    const [a, b, c] = transcripts;
    const one = (t: string) =>
      readClaudeHelpers(t, { agentLive: true, settings: tiny });
    one(a);
    one(b);
    one(a);
    one(c);
    const r = transcriptBytesReadDuring(() => one(a));
    expect(total(r)).toBe(0);
    const s = transcriptBytesReadDuring(() => one(b));
    expect(total(s)).toBeGreaterThan(0);
  });
});
