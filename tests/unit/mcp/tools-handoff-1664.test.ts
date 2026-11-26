import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { toolsStaleMessage } from "../../../src/ui/server/engine-stamp.js";
import { superviseMcp } from "../../../src/ui/mcp/supervisor.js";

const CHILD = path.join(__dirname, "../../fixtures/mcp-handoff/child.mjs");
let dir = "";
let versionFile = "";
let stampFile = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1664b-"));
  versionFile = path.join(dir, "version");
  stampFile = path.join(dir, "stamp");
  fs.writeFileSync(versionFile, "0.4.90");
  fs.writeFileSync(stampFile, "build-a");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function update(version: string, stamp: string) {
  fs.writeFileSync(versionFile, version);
  fs.writeFileSync(stampFile, stamp);
}

type Msg = {
  id?: number | string;
  method?: string;
  result?: { content?: { text: string }[]; serverInfo?: { version: string } };
  error?: { message: string };
};

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];
  const seen: Msg[] = [];
  const waiting = new Map<number | string, (m: Msg) => void>();
  let buf = "";
  output.on("data", (c: Buffer) => {
    buf += c.toString();
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Msg;
      buf = buf.slice(i + 1);
      seen.push(m);
      if (m.id !== undefined && !m.method) waiting.get(m.id)?.(m);
    }
  });
  const sup = superviseMcp({
    spawn: () =>
      spawn(process.execPath, [CHILD], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, FAKE_VERSION_FILE: versionFile },
      }),
    stamp: () => fs.readFileSync(stampFile, "utf-8"),
    input,
    output,
    log: (l) => logs.push(l),
    initTimeoutMs: 5_000,
  });
  let next = 1;
  const send = (m: object) => input.write(JSON.stringify(m) + "\n");
  const request = (method: string, params: object = {}) => {
    const id = next++;
    const got = new Promise<Msg>((r) => waiting.set(id, r));
    send({ jsonrpc: "2.0", id, method, params });
    return got;
  };
  const call = async (args: object = {}) =>
    (await request("tools/call", { name: "t", arguments: args })).result
      ?.content?.[0]?.text ?? "";
  const start = async () => {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init;
  };
  const stop = async () => {
    input.end();
    await sup.done;
  };
  return { start, call, request, stop, seen, logs };
}

describe("Den updated under a running tools process (issue 1664)", () => {
  it("the next call runs the new version's code, with the conversation kept", async () => {
    const h = harness();
    await h.start();
    const before = await h.call();
    expect(before).toMatch(/^version=0\.4\.90 /);
    update("0.4.91", "build-b");
    const after = await h.call();
    expect(after).toMatch(/^version=0\.4\.91 /);
    expect(after).toMatch(/inits=1$/);
    expect(after.match(/pid=(\d+)/)?.[1]).not.toBe(
      before.match(/pid=(\d+)/)?.[1],
    );
    await h.stop();
  });

  it("tells the client its tool list changed, and lists the new tools", async () => {
    const h = harness();
    await h.start();
    update("0.4.91", "build-b");
    await h.call();
    expect(h.seen.map((m) => m.method)).toContain(
      "notifications/tools/list_changed",
    );
    const list = (await h.request("tools/list")) as {
      result?: { tools?: { name: string }[] };
    };
    expect(list.result?.tools?.map((t) => t.name)).toEqual(["tool_0.4.91"]);
    await h.stop();
  });

  it("a call already running on the old code finishes there", async () => {
    const h = harness();
    await h.start();
    const slow = h.call({ ms: 400 });
    await new Promise((r) => setTimeout(r, 50));
    update("0.4.91", "build-b");
    const fresh = await h.call();
    expect(fresh).toMatch(/^version=0\.4\.91 /);
    expect(await slow).toMatch(/^version=0\.4\.90 /);
    await h.stop();
  });

  it("a new version that fails to start: the old one keeps answering", async () => {
    const h = harness();
    await h.start();
    update("broken", "build-b");
    expect(await h.call()).toMatch(/^version=0\.4\.90 /);
    expect(await h.call()).toMatch(/^version=0\.4\.90 /);
    expect(h.logs.filter((l) => l.includes("build-b"))).toHaveLength(1);
    update("0.4.92", "build-c");
    expect(await h.call()).toMatch(/^version=0\.4\.92 /);
    await h.stop();
  });

  it("the tools process stopping mid-call: that call fails, the next one works", async () => {
    const h = harness();
    await h.start();
    const lost = await h.request("tools/call", {
      name: "t",
      arguments: { crash: true },
    });
    expect(lost.error?.message).toMatch(/stopped/);
    expect(await h.call()).toMatch(/^version=0\.4\.90 /);
    await h.stop();
  });

  it("no update: every call goes to the same process", async () => {
    const h = harness();
    await h.start();
    const pids = new Set<string>();
    for (let i = 0; i < 3; i++)
      pids.add((await h.call()).match(/pid=(\d+)/)?.[1] ?? "");
    expect(pids.size).toBe(1);
    await h.stop();
  });
});

describe("the note a supervised tools process adds", () => {
  const c = {
    loaded: { version: "0.4.90", buildId: "a" },
    onDisk: { version: "0.4.91", buildId: "b" },
    stale: true,
  };

  it("never asks for a restart: the next call runs the new tools", () => {
    for (const agent of [true, false]) {
      const note = toolsStaleMessage(c, agent, true);
      expect(note).not.toMatch(/restart|reconnect/i);
      expect(note).toMatch(/next call runs 0\.4\.91/);
    }
  });

  it("unsupervised, it still says how to load the new tools", () => {
    expect(toolsStaleMessage(c, true)).toMatch(/restart you from Den/);
  });
});
