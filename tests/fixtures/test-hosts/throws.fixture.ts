/**
 * Issue 501: a test that starts a session host with the helper and throws
 * before it stops it, for tests/unit/test-infra/test-hosts.test.ts, which
 * runs it in a child jest. Not a *.test.ts: the suite never runs it on its
 * own, and it does nothing unless DEN_TEST_HOSTS_FIXTURE_OUT is set.
 *
 * The throw is expected (`it.failing`), so the child run passes only when
 * the helper stopped the host after the test.
 */
import { expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { startTestHost } from "../../test-hosts.js";

const out = process.env.DEN_TEST_HOSTS_FIXTURE_OUT;
const dir = process.env.DEN_TEST_HOSTS_FIXTURE_DIR;
const PIPE_HOST = path.join(
  __dirname,
  "../../unit/sessions/helpers/pipe-host.ts",
);

it.failing("starts a host and throws before its teardown", async () => {
  if (!out || !dir) throw new Error("not in the child run");
  startTestHost(PIPE_HOST, dir);
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      const c = await connectHost(sessionPaths(dir).socket);
      fs.writeFileSync(out, String(c.hostPid));
      c.close();
      break;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("thrown before the host is stopped");
}, 60_000);

it("the host it started is gone once that test ended", () => {
  if (!out) return;
  const pid = Number(fs.readFileSync(out, "utf-8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});
