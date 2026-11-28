import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

const ENGINE = path.resolve(__dirname, "..", "..", "..");
const LOADER = path.join(ENGINE, "node_modules/tsx/dist/loader.mjs");
const HOST = path.join(ENGINE, "tests/unit/sessions/helpers/module-host.ts");

const FAKE = `
const { spawn } = require("child_process");
spawn(process.execPath, ["--import", process.env.T_LOADER, process.env.T_HOST, process.env.DEN_HOME], {
  detached: true, stdio: "ignore",
}).unref();
setInterval(() => {}, 1 << 30);
`;

let tmp = "";
let server: ChildProcess | undefined;
let hostPid = 0;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1892-")));
  const home = path.join(tmp, "home", ".den");
  fs.mkdirSync(home, { recursive: true });
  server = spawnServer(process.execPath, ["-e", FAKE], {
    cwd: tmp,
    stdio: "ignore",
    env: {
      ...process.env,
      DEN_HOME: home,
      T_LOADER: `file://${LOADER}`,
      T_HOST: HOST,
    },
  });
  const end = Date.now() + 20_000;
  while (!hostPid && Date.now() < end) {
    try {
      const c = await connectHost(sessionPaths(home).socket);
      hostPid = c.hostPid;
      c.close();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}, 30_000);

afterAll(() => {
  if (hostPid && alive(hostPid)) process.kill(hostPid, "SIGKILL");
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("stopServer and the server's session host (issue 1892)", () => {
  it("stops the host the server started, and waits for it to end", async () => {
    expect(hostPid).toBeGreaterThan(0);
    await stopServer(server);
    expect(alive(hostPid)).toBe(false);
  }, 30_000);
});
