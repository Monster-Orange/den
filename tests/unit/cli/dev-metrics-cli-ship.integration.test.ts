/**
 * An opted-in CLI run sends its invocation event (den#2 follow-up).
 *
 * The CLI records its run in the process `exit` handler, where an async
 * fetch never gets to run: the event went to the JSONL buffer and was never
 * sent. It is now handed to a short-lived detached sender, bounded at 2s.
 * Not opted in, nothing is sent.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawnSync } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const ENGINE = path.resolve(__dirname, "../../..");

let sink: http.Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  sink = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push(`${req.method} ${req.url} ${body}`);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => sink.listen(0, "localhost", () => r()));
  port = (sink.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => sink.close(() => r()));
});

function runCli(share: boolean): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dm-cli-"));
  fs.mkdirSync(path.join(dir, "config", "local"), { recursive: true });
  if (share)
    fs.writeFileSync(
      path.join(dir, "config", "local", "user.yml"),
      "metrics:\n  share: true\n",
    );
  const r = spawnSync(path.join(ENGINE, "bin", "den"), ["--version"], {
    cwd: dir,
    encoding: "utf-8",
    input: "",
    env: {
      HOME: path.join(dir, "home"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      DEV_METRICS_REPO_ROOT: dir,
      DEV_METRICS_SENTRY_DSN: `http://k@localhost:${port}/9`,
      NO_COLOR: "1",
    },
  });
  expect(r.status).toBe(0);
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("dev-metrics from a CLI run", () => {
  it("not opted in: nothing reaches the sink", async () => {
    hits.length = 0;
    runCli(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect(hits).toEqual([]);
  }, 20000);

  it("opted in: the invocation event reaches the sink after the CLI exits", async () => {
    hits.length = 0;
    runCli(true);
    const got = await waitFor(() => hits.length > 0, 4000);
    expect(got).toBe(true);
    expect(hits[0]).toMatch(/^POST \/api\/9\/envelope\//);
    expect(hits[0]).toContain("devtool.");
  }, 20000);
});
