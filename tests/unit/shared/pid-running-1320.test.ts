/**
 * Issue 1320: a process that has ended but is not yet reaped (a zombie) is
 * not running. kill(pid, 0) still succeeds for it, so the gate store read a
 * killed run's command as alive while nobody reaped it (a container whose
 * first process never reaps, or a slow one under load): the slot was never
 * taken back and the workers it left were never stopped.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import { pidRunning } from "../../../src/shared/process/process-group.js";

const stat = (pid: number, state: string) =>
  `${pid} (node (worker)) ${state} 1 ${pid} ${pid} 0 -1 4194560`;

describe("pidRunning", () => {
  it("a pid kill(0) can't reach is not running", () => {
    expect(pidRunning(2 ** 22 + 7)).toBe(false);
  });

  it("on Linux a zombie is not running; any other state is", () => {
    const self = process.pid;
    const read = (state: string) => () => stat(self, state);
    expect(pidRunning(self, { platform: "linux", readStat: read("Z") })).toBe(
      false,
    );
    for (const s of ["R", "S", "D", "T"])
      expect(pidRunning(self, { platform: "linux", readStat: read(s) })).toBe(
        true,
      );
  });

  it("a name with ') ' in it doesn't hide the state", () => {
    const self = process.pid;
    const odd = () => `${self} (a) Z (b) S 1 ${self}`;
    expect(pidRunning(self, { platform: "linux", readStat: odd })).toBe(true);
  });

  it("on Linux, its stat gone since kill(0): ended", () => {
    const gone = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(pidRunning(process.pid, { platform: "linux", readStat: gone })).toBe(
      false,
    );
  });

  it("another user's live process under hidepid (EPERM, then no /proc entry): running", () => {
    const eperm = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    const gone = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(
      pidRunning(4242, { platform: "linux", kill: eperm, readStat: gone }),
    ).toBe(true);
  });

  it("on Linux, stat unreadable after kill(0) succeeded: running", () => {
    const fail = () => {
      throw new Error("EACCES");
    };
    expect(pidRunning(process.pid, { platform: "linux", readStat: fail })).toBe(
      true,
    );
  });
});

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
});

(process.platform === "linux" ? describe : describe.skip)(
  "pidRunning on a real zombie (Linux)",
  () => {
    it("a child its parent never waits for reads as not running once it ends", async () => {
      // sh starts `sleep 0`, prints its pid, then becomes `sleep 30`, which
      // never waits: the ended `sleep 0` stays a zombie under it.
      const k = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      kids.push(k);
      const pid = await new Promise<number>((resolve) =>
        k.stdout!.once("data", (d: Buffer) => resolve(Number(String(d)))),
      );
      const t0 = Date.now();
      while (Date.now() - t0 < 5_000 && pidRunning(pid))
        await new Promise((r) => setTimeout(r, 50));
      let reachable = true;
      try {
        process.kill(pid, 0);
      } catch {
        reachable = false;
      }
      expect({ reachable, running: pidRunning(pid) }).toEqual({
        reachable: true,
        running: false,
      });
    });
  },
);
