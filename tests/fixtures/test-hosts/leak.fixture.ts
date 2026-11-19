/**
 * Issue 501: a test that starts a session host outside the helper and
 * leaves it running, for tests/unit/test-infra/test-hosts.test.ts, which
 * runs it in a child jest. Not a *.test.ts: the suite never runs it on its
 * own, and it does nothing unless DEN_TEST_HOSTS_FIXTURE_OUT is set.
 *
 * It asks for a host the way Den's CLI does (`sessions` starts one on
 * demand, detached), in DEN_TEST_HOSTS_FIXTURE_DIR, and writes the host's
 * pid to DEN_TEST_HOSTS_FIXTURE_OUT. Nothing stops it: the run's guard must.
 */
import { expect, it } from "@jest/globals";
import * as fs from "fs";
import { resolveDeps } from "../../../src/ui/cli/sessions-command.js";

const out = process.env.DEN_TEST_HOSTS_FIXTURE_OUT;
const dir = process.env.DEN_TEST_HOSTS_FIXTURE_DIR;

it("starts a host and leaves it running", async () => {
  if (!out || !dir) return;
  process.env.DEN_HOME = dir;
  const c = await resolveDeps({ stateDir: () => dir }).connect();
  fs.writeFileSync(out, String(c.hostPid));
  c.close();
  expect(c.hostPid).toBeGreaterThan(1);
}, 60_000);
