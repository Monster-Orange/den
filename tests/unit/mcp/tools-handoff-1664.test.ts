import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { toolsStaleMessage } from "../../../src/ui/server/engine-stamp.js";
import { childCommand, superviseMcp } from "../../../src/ui/mcp/supervisor.js";

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
  const spawned = { n: 0 };
  const sup = superviseMcp({
    spawn: () =>
      (spawned.n++, spawn)(process.execPath, [CHILD], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, FAKE_VERSION_FILE: versionFile },
      }),
    stamp: () => fs.readFileSync(stampFile, "utf-8"),
    input,
    output,
    log: (l) => logs.push(l),
    initTimeoutMs: 5_000,
    retryAfterMs: 200,
    restartLimit: 3,
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
  return { start, call, request, send, stop, seen, logs, spawned };
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

  it("two calls racing a handoff both run on the new code, in order; one cancelled meanwhile never runs", async () => {
    const h = harness();
    await h.start();
    update("0.4.91", "build-b");
    const a = h.call();
    const b = h.call();
    const gone = h.request("tools/call", { name: "t", arguments: {} });
    h.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 4, reason: "test" },
    });
    expect(await a).toMatch(/^version=0\.4\.91 /);
    expect(await b).toMatch(/^version=0\.4\.91 /);
    const settled = await Promise.race([
      gone.then(() => "answered"),
      new Promise((r) => setTimeout(() => r("never"), 300)),
    ]);
    expect(settled).toBe("never");
    const handoffs = h.logs.filter((l) => l.includes("the next calls run"));
    expect(handoffs).toHaveLength(1);
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

  it("a fresh process that can't start either: calls get an error, never a hang, and a later call retries", async () => {
    const h = harness();
    await h.start();
    fs.writeFileSync(versionFile, "broken");
    const lost = await h.request("tools/call", {
      name: "t",
      arguments: { crash: true },
    });
    expect(lost.error?.message).toMatch(/stopped/);
    const refused = await Promise.race([
      h.request("tools/call", { name: "t", arguments: {} }),
      new Promise<Msg>((r) =>
        setTimeout(() => r({ error: { message: "hung" } }), 3_000),
      ),
    ]);
    expect(refused.error?.message).toMatch(/could not start/);
    fs.writeFileSync(versionFile, "0.4.90");
    await new Promise((r) => setTimeout(r, 250));
    expect(await h.call()).toMatch(/^version=0\.4\.90 /);
    await h.stop();
  });

  it("a process that keeps dying as it starts: one try per call, the tries stop at the cap, and every call gets an answer at once", async () => {
    const h = harness();
    await h.start();
    fs.writeFileSync(versionFile, "flaky");
    await h.request("tools/call", { name: "t", arguments: { crash: true } });
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const t0 = Date.now();
      const r = await Promise.race([
        h.request("tools/call", { name: "t", arguments: {} }),
        new Promise<Msg>((res) =>
          setTimeout(() => res({ error: { message: "hung" } }), 2_000),
        ),
      ]);
      expect(Date.now() - t0).toBeLessThan(1_500);
      answers.push(r.error?.message ?? r.result?.content?.[0]?.text ?? "");
    }
    expect(answers).not.toContain("hung");
    expect(h.spawned.n).toBeLessThanOrEqual(1 + 3);
    expect(answers[answers.length - 1]).toMatch(/gave up/);
    await h.stop();
  });

  it("the first process failing at start: initialize gets an error, and calls never hang", async () => {
    fs.writeFileSync(versionFile, "broken");
    const h = harness();
    const init = await Promise.race([
      h.start(),
      new Promise<Msg>((r) =>
        setTimeout(() => r({ error: { message: "hung" } }), 3_000),
      ),
    ]);
    expect(init.error?.message).toMatch(/stopped|could not start/);
    const r = await Promise.race([
      h.request("tools/call", { name: "t", arguments: {} }),
      new Promise<Msg>((res) =>
        setTimeout(() => res({ error: { message: "hung" } }), 3_000),
      ),
    ]);
    expect(r.error?.message).toMatch(/stopped|could not start/);
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

describe("what a fresh tools process is given", () => {
  it("the parent's own flags and env, unchanged, plus only the child marker", () => {
    const argv = [
      "--workspace",
      "north",
      "--actor",
      "agent:a1",
      "--grant",
      "west",
    ];
    const env = { DEN_ACTOR_TOKEN: "tok", PATH: "/bin" };
    const c = childCommand(argv, "/engine", env);
    expect(c.file).toBe(path.join("/engine", "bin", "den"));
    expect(c.args).toEqual(["mcp", ...argv]);
    expect(c.env).toEqual({ ...env, DEN_MCP_CHILD: "1" });
    expect(env).toEqual({ DEN_ACTOR_TOKEN: "tok", PATH: "/bin" });
  });
});

describe("the note a supervised tools process adds", () => {
  const c = {
    loaded: { version: "0.4.90", buildId: "a" },
    onDisk: { version: "0.4.91", buildId: "b" },
    stale: true,
  };

  it("says the next call should run the new tools, and asks for a restart only if the note shows again", () => {
    for (const agent of [true, false]) {
      const note = toolsStaleMessage(c, agent, true);
      expect(note).toMatch(/next call should run 0\.4\.91's tools/);
      const [first, again] = note.split("If this note shows again");
      expect(first).not.toMatch(/restart|reconnect/i);
      expect(again).toMatch(agent ? /restart you from Den/ : /reconnect/);
    }
  });

  it("unsupervised, it still says how to load the new tools", () => {
    expect(toolsStaleMessage(c, true)).toMatch(/restart you from Den/);
  });
});
