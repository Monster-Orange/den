/**
 * issue 206: what a person reads from the CLI is in this machine's own
 * zone, never raw ISO UTC; --json keeps the ISO stamp. A child process
 * with TZ=America/Los_Angeles runs `web owner show` on a stored owner
 * linked at 2026-11-16T00:32:05Z (4:32 PM the day before in Los Angeles).
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeWebOwner } from "../../../src/shared/web-owner.js";
import { localDate, localDateTime } from "../../../src/shared/local-time.js";

const ROOT = path.join(__dirname, "../../..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-tz-cli-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** `web owner show [--json]` in a child whose zone is `tz`. */
function ownerShow(tz: string, json = false): string {
  const script = path.join(tmp, "run.mts");
  fs.writeFileSync(
    script,
    `import { cmdWebOwner } from ${JSON.stringify(path.join(ROOT, "src/ui/cli/web-command.ts"))};\n` +
      `let out = "";\n` +
      `await cmdWebOwner(${JSON.stringify(json ? ["show", "--json"] : ["show"])}, {\n` +
      `  out: (s) => (out += s), err: () => undefined, stateDir: ${JSON.stringify(tmp)},\n` +
      `});\n` +
      `process.stdout.write(out);\n`,
  );
  const r = spawnSync(TSX, [script], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      TZ: tz,
      TSX_DISABLE_CACHE: "1",
      DEN_ROOT: ROOT,
      DEN_HOME: path.join(tmp, "home"),
    },
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return r.stdout;
}

describe("CLI date-times for people (issue 206)", () => {
  it("web owner show: the machine's zone, not UTC; --json stays ISO", () => {
    writeWebOwner(
      { id: 4242, login: "octo-owner" },
      tmp,
      new Date("2026-11-16T00:32:05.000Z"),
    );
    expect(ownerShow("America/Los_Angeles")).toBe(
      "Owner: @octo-owner (github:4242), linked 2026-11-15 16:32 PST.\n",
    );
    expect(ownerShow("Asia/Tokyo")).toMatch(/linked 2026-11-16 09:32 GMT\+9\./);
    expect(ownerShow("America/Los_Angeles", true)).toContain(
      '"linkedAt": "2026-11-16T00:32:05.000Z"',
    );
  }, 120_000);

  it("localDateTime and localDate: a fixed zone; a bad stamp as given", () => {
    const iso = "2026-01-01T03:00:00Z";
    expect(localDateTime(iso, "America/Los_Angeles")).toBe(
      "2025-12-31 19:00 PST",
    );
    expect(localDateTime(iso, "UTC")).toBe("2026-01-01 03:00 UTC");
    expect(localDate(iso, "America/Los_Angeles")).toBe("2025-12-31");
    expect(localDateTime("nope")).toBe("nope");
    expect(localDateTime(undefined)).toBe("");
  });
});
