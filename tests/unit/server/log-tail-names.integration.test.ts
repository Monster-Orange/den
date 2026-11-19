/**
 * The live log route (/api/service/taillog) takes only catalog-shaped repo
 * and service names, as the history and search routes do, and starts its
 * tail with an argument list, never a command line. Against the real server
 * in a throwaway distribution (helpers/error-frame-server.ts). A name that
 * isn't one is refused with 400 before anything runs or any folder is made.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";
import { tailArgv } from "../../../src/ui/server/log-history.js";

let s: FrameServer | null = null;

const DOCKER = `#!/bin/sh
case "$*" in
  ps*) exit 0 ;;
esac
exit 1
`;

beforeAll(async () => {
  s = await startFrameServer({
    prefix: "den-logtail-",
    shims: { docker: DOCKER },
  });
}, 40_000);

afterAll(async () => {
  await s?.stop();
  removeFrameTmp(s);
});

function get(
  query: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${s!.base}/api/service/taillog?${new URLSearchParams(query)}`,
      {
        agent: false,
        // 0.4.71: a log route runs a command: the CLI's token.
        headers: denAuth(path.join(s!.tmp, "den-home")),
      },
      (res) => {
        let body = "";
        const done = () => {
          clearTimeout(timer);
          res.destroy();
          resolve({ status: res.statusCode ?? 0, body });
        };
        const timer = setTimeout(done, 3_000);
        res.on("data", (d: Buffer) => {
          body += d.toString();
          if (res.statusCode !== 200 || /startup log/.test(body)) done();
        });
        res.on("end", done);
      },
    );
    req.on("error", reject);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 1_500));

describe("the live log route's names", () => {
  const marker = () => path.join(s!.tmp, "ran");
  const bad = (m: string) => [
    `$(touch ${m})`,
    `\`touch ${m}\``,
    `x";touch ${m};"`,
    `x; touch ${m}`,
    `x|touch ${m}`,
  ];

  it("refuses a service name that isn't one, and runs nothing", async () => {
    for (const service of bad(marker())) {
      const r = await get({ repo: "nothing-here", service });
      expect(r.status).toBe(400);
    }
    await settle();
    expect(fs.existsSync(marker())).toBe(false);
  }, 30_000);

  it("refuses a repo name that isn't one, and runs nothing", async () => {
    for (const repo of bad(marker())) {
      const r = await get({ repo, service: "svc" });
      expect(r.status).toBe(400);
    }
    await settle();
    expect(fs.existsSync(marker())).toBe(false);
  }, 30_000);

  it("makes no folder outside the logs folder", async () => {
    const r = await get({ repo: "../../outside-logs", service: "svc" });
    expect(r.status).toBe(400);
    expect(fs.existsSync(path.join(s!.tmp, "outside-logs"))).toBe(false);
  }, 15_000);

  it("still tails a real name's startup log", async () => {
    const r = await get({ repo: "nothing-here", service: "svc" });
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/startup log/);
  }, 15_000);
});

describe("tailArgv", () => {
  it("is an argument list, the path one argument as given", () => {
    const p = '/tmp/a b/$(x)"`y`.log';
    expect(tailArgv(p, 500)).toEqual(["tail", ["-F", "-n", "500", p]]);
  });
});
