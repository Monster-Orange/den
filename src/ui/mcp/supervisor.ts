import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import { readEngineStamp } from "../server/engine-stamp.js";
import type { Readable, Writable } from "stream";

export interface SuperviseOptions {
  spawn(): ChildProcess;
  stamp(): string | null;
  input: Readable;
  output: Writable;
  log(line: string): void;
  initTimeoutMs?: number;
}

type Id = string | number;
interface Message {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: { requestId?: Id } & Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface Tools {
  proc: ChildProcess;
  stamp: string | null;
  inflight: Set<Id>;
  retiring: boolean;
  exited: boolean;
  onMessage: (m: Message) => void;
}

const HANDOFF = "den-handoff-";
export const MCP_CHILD_ENV = "DEN_MCP_CHILD";

function lines(stream: Readable, each: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (c: string) => {
    buf += c;
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) each(line);
    }
  });
}

export function superviseMcp(o: SuperviseOptions): { done: Promise<void> } {
  const initTimeoutMs = o.initTimeoutMs ?? 20_000;
  const write = (m: Message) => o.output.write(JSON.stringify(m) + "\n");
  let initialize: Message | null = null;
  let initialized: Message | null = null;
  let current: Tools;
  let swapping = false;
  let failedStamp: string | null = null;
  let handoffs = 0;
  let inputEnded = false;
  const queue: Message[] = [];
  const asked = new Map<Id, Tools>();
  const all = new Set<Tools>();
  let finish: () => void = () => undefined;
  const done = new Promise<void>((r) => (finish = r));

  const stampNow = () => {
    try {
      return o.stamp();
    } catch {
      return null;
    }
  };

  const send = (t: Tools, m: Message) => {
    if (!t.exited) t.proc.stdin?.write(JSON.stringify(m) + "\n");
  };

  const retire = (t: Tools) => {
    if (t.retiring && t.inflight.size === 0 && !t.exited) t.proc.stdin?.end();
  };

  const settle = () => {
    if (inputEnded && [...all].every((t) => t.exited)) finish();
  };

  const start = (): Tools => {
    const t: Tools = {
      proc: o.spawn(),
      stamp: stampNow(),
      inflight: new Set(),
      retiring: false,
      exited: false,
      onMessage: (m) => fromTools(t, m),
    };
    all.add(t);
    t.proc.stdin?.on("error", () => undefined);
    if (t.proc.stdout) lines(t.proc.stdout, (l) => parse(l, t.onMessage));
    t.proc.on("exit", (code) => {
      t.exited = true;
      all.delete(t);
      for (const id of t.inflight)
        write({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `Den's tools process stopped (exit ${code}) during this call. Call again: the next call starts a fresh one.`,
          },
        });
      t.inflight.clear();
      if (t === current && !t.retiring && !inputEnded) replace();
      settle();
    });
    return t;
  };

  const parse = (line: string, to: (m: Message) => void) => {
    try {
      to(JSON.parse(line) as Message);
    } catch {
      o.log(
        `[mcp] supervisor: an unreadable line from Den's tools was dropped`,
      );
    }
  };

  const fromTools = (t: Tools, m: Message) => {
    const isResponse = m.method === undefined && m.id !== undefined;
    if (isResponse) {
      t.inflight.delete(m.id!);
      write(m);
      retire(t);
      return;
    }
    if (m.id !== undefined) asked.set(m.id, t);
    write(m);
  };

  const route = (m: Message) => {
    const t = current;
    if (m.id !== undefined) t.inflight.add(m.id);
    send(t, m);
  };

  const flush = () => {
    while (queue.length && !swapping) route(queue.shift()!);
  };

  const handshake = (t: Tools): Promise<boolean> =>
    new Promise((resolve) => {
      if (!initialize) return resolve(true);
      const id = `${HANDOFF}${++handoffs}`;
      const timer = setTimeout(() => end(false), initTimeoutMs);
      const exit = () => end(false);
      const end = (ok: boolean) => {
        clearTimeout(timer);
        t.proc.off("exit", exit);
        t.onMessage = (m) => fromTools(t, m);
        resolve(ok);
      };
      t.proc.once("exit", exit);
      t.onMessage = (m) => {
        if (m.id === id && m.method === undefined) return end(!m.error);
        fromTools(t, m);
      };
      send(t, { ...initialize, id });
      if (t.exited) end(false);
    });

  const adopt = (t: Tools, old: Tools | null) => {
    if (initialized) send(t, initialized);
    current = t;
    if (old) {
      old.retiring = true;
      retire(old);
    }
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  };

  const handoff = async () => {
    swapping = true;
    const old = current;
    const next = start();
    if (await handshake(next)) {
      o.log(
        `[mcp] supervisor: Den was updated; the next calls run the new tools`,
      );
      adopt(next, old);
    } else {
      failedStamp = next.stamp;
      next.retiring = true;
      if (!next.exited) next.proc.kill();
      o.log(
        `[mcp] supervisor: the updated Den's tools (build ${next.stamp ?? "unknown"}) did not start; these keep answering`,
      );
    }
    swapping = false;
    flush();
  };

  const replace = () => {
    swapping = true;
    const next = start();
    void handshake(next).then((ok) => {
      if (!ok)
        o.log(
          `[mcp] supervisor: a fresh tools process did not answer its start`,
        );
      adopt(next, null);
      swapping = false;
      flush();
    });
  };

  const stale = () => {
    const now = stampNow();
    return now !== null && now !== current.stamp && now !== failedStamp;
  };

  const fromClient = (m: Message) => {
    if (m.method === "initialize" && m.id !== undefined) initialize = m;
    if (m.method === "notifications/initialized") initialized = m;
    if (m.method === undefined && m.id !== undefined) {
      const owner = asked.get(m.id) ?? current;
      asked.delete(m.id);
      return send(owner, m);
    }
    if (
      m.method === "notifications/cancelled" &&
      m.params?.requestId !== undefined
    ) {
      const id = m.params.requestId;
      const queued = queue.findIndex((q) => q.id === id);
      if (queued !== -1) return void queue.splice(queued, 1);
      const owner = [...all].find((t) => t.inflight.has(id));
      if (owner) send(owner, m);
      return;
    }
    if (swapping) return void queue.push(m);
    if (m.id !== undefined && initialized && stale()) {
      queue.push(m);
      void handoff();
      return;
    }
    route(m);
  };

  current = start();
  lines(o.input, (l) => parse(l, fromClient));
  o.input.on("end", () => {
    inputEnded = true;
    for (const t of all) {
      t.retiring = true;
      if (!t.exited) t.proc.stdin?.end();
    }
    settle();
  });
  return { done };
}

export function childCommand(
  argv: readonly string[],
  engineRoot: string,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    file: path.join(engineRoot, "bin", "den"),
    args: ["mcp", ...argv],
    env: { ...env, [MCP_CHILD_ENV]: "1" },
  };
}

export async function superviseStdio(
  argv: string[],
  engineRoot: string,
): Promise<void> {
  const { done } = superviseMcp({
    spawn: () => {
      const c = childCommand(argv, engineRoot, process.env);
      return spawn(c.file, c.args, {
        stdio: ["pipe", "pipe", "inherit"],
        env: c.env,
      });
    },
    stamp: () => readEngineStamp(engineRoot).buildId,
    input: process.stdin,
    output: process.stdout,
    log: (l) => process.stderr.write(`${l}\n`),
  });
  await done;
}
