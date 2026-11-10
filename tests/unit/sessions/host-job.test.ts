/**
 * D18: when `service install` set up the session host as a launchd job,
 * `<cli> sessions` waits for that job and never starts a host of its own
 * (which would run in the caller's launchd session: a desktop one ends at
 * logout). A stale job file (its plist gone) is ignored.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hostJob } from "../../../src/ui/cli/sessions-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function state(job?: unknown): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-hostjob-"));
  tmps.push(d);
  if (job !== undefined)
    fs.writeFileSync(
      path.join(d, "sessions-host-job.json"),
      JSON.stringify(job),
    );
  return d;
}

describe("hostJob", () => {
  it("is the job when its file and its plist are there", () => {
    const d = state({ label: "local.acme.sessions", mode: "always" });
    const seen: string[] = [];
    const job = hostJob(d, "/home/u", (p) => {
      seen.push(p);
      return p === "/Library/LaunchDaemons/local.acme.sessions.plist";
    });
    expect(job).toEqual({ label: "local.acme.sessions", mode: "always" });
  });

  it("finds a login job's LaunchAgent", () => {
    const d = state({ label: "local.acme.sessions", mode: "login" });
    expect(
      hostJob(
        d,
        "/home/u",
        (p) => p === "/home/u/Library/LaunchAgents/local.acme.sessions.plist",
      ),
    ).toEqual({ label: "local.acme.sessions", mode: "login" });
  });

  it("is null with no file, a stale file (no plist), or a bad label", () => {
    expect(hostJob(state(), "/home/u", () => true)).toBeNull();
    expect(
      hostJob(state({ label: "local.acme.sessions" }), "/home/u", () => false),
    ).toBeNull();
    expect(
      hostJob(state({ label: "../../etc/x" }), "/home/u", () => true),
    ).toBeNull();
    const bad = state();
    fs.writeFileSync(path.join(bad, "sessions-host-job.json"), "{not json");
    expect(hostJob(bad, "/home/u", () => true)).toBeNull();
  });
});
