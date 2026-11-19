/**
 * Issue 563: the real web server, started on a distribution whose terminal
 * host outlived an update: the host says it loaded a native PTY module
 * that is no longer on disk (npm deleted its folder). Every new agent or
 * terminal would fail to start in it ("posix_spawnp failed"). At its
 * start, the web server restarts that host the way `sessions host --stop`
 * does, says so in the log and the audit, and a host on the installed
 * version answers after.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

let srv: AgentsPageServer | null = null;

afterEach(async () => {
  if (!srv) return;
  // The host the web server started in place of the stale one.
  try {
    const c = await connectHost(sessionPaths(srv.stateDir).socket);
    await c.shutdown();
    c.close();
  } catch {
    /* none */
  }
  await srv.stop();
  srv = null;
}, 30_000);

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return ok();
}

describe("issue 563: web start-up and a terminal host left on a deleted module", () => {
  it("restarts the host, and the host that answers after runs the installed version", async () => {
    srv = await startAgentsPageServer({
      hostPty: {
        path: path.join("/nonexistent-563", ".node-pty-gone", "pty.node"),
        version: "1.1.0",
        id: "sha256:old",
      },
    });
    expect(await until(() => srv!.hostClosed(), 45_000)).toBe(true);
    expect(
      await until(() => /terminal host restarted/.test(srv!.log()), 30_000),
    ).toBe(true);
    const c = await connectHost(sessionPaths(srv.stateDir).socket);
    try {
      const pkg = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, "../../..", "package.json"),
          "utf-8",
        ),
      ) as { version: string };
      expect(c.hostDen).toBe(pkg.version);
      // A module it loads is the installed one, on disk.
      if (c.hostPty) expect(fs.existsSync(c.hostPty.path)).toBe(true);
    } finally {
      c.close();
    }
  }, 120_000);
});
