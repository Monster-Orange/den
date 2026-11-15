/**
 * den#182: `hub put`, `hub pull` and `hub push` send the agent's Den token
 * only to this Den. Whatever answers on the port is asked whose it is
 * first (/api/server-info, the identity check the other commands use); a
 * stand-in that answers but is not this Den gets no request with the token.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cmdHub } from "../../../src/ui/cli/hub-command.js";

const AGENT_TOKEN = "den_at_TESTONLY0den182000agent0token00000000000";

interface Seen {
  url: string;
  auth: string | undefined;
}

const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

/** Answers every path; server-info says it is some other install. */
async function standIn(info: (res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url === "/api/server-info") return info(res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pack: "pk1", files: [], missing: [] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => srv.close());
  const port = (srv.address() as AddressInfo).port;
  return { seen, base: `http://127.0.0.1:${port}` };
}

const foreign = (res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ product: "other-den", root: "/srv/other-den", pid: 1 }),
  );
};
const notDen = (res: http.ServerResponse) => {
  res.writeHead(404);
  res.end("not found");
};

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den182-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, "index.html"), "<h1>x</h1>");
  fs.writeFileSync(path.join(d, "pack.json"), JSON.stringify({ files: [] }));
  return d;
}

const runs: [string, (d: string) => string[]][] = [
  ["push", (d) => ["push", d]],
  ["put", (d) => ["put", d, "hub:some-page"]],
  ["pull", (d) => ["pull", "hub:some-page@latest", path.join(d, "out")]],
];

describe("CLI hub commands check whose Den it is before the token (den#182)", () => {
  for (const [name, args] of runs)
    for (const [kind, info] of [
      ["another install", foreign],
      ["a non-Den answer", notDen],
    ] as const)
      it(`hub ${name}: ${kind} on the port gets no token`, async () => {
        const s = await standIn(info);
        const err: string[] = [];
        const code = await cmdHub(args(tmp()), {
          env: { DEN_ACTOR_TOKEN: AGENT_TOKEN },
          denBase: () => s.base,
          out: () => undefined,
          err: (l) => err.push(l),
        });
        expect(code).toBe(1);
        expect(s.seen.filter((x) => x.auth !== undefined)).toEqual([]);
        expect(s.seen.map((x) => x.url)).toEqual(["/api/server-info"]);
        expect(err.join("\n")).toMatch(
          /not this Den; the agent's token was not sent/,
        );
        expect(err.join("\n")).not.toContain(AGENT_TOKEN);
      });
});
