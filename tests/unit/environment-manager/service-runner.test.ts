import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DaemonRecord } from "../../../src/shared/environment-manager/service-runner.js";

const tmpRoots: string[] = [];

function makeTempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-daemons-"));
  tmpRoots.push(dir);
  return path.join(dir, name);
}

function daemon(
  address: string,
  logPath = `/tmp/${address}.log`,
): DaemonRecord {
  return {
    address,
    repoName: address.split("/")[0],
    subsystem: address.includes("/") ? address.split("/")[1] : address,
    repoPath: `/repos/${address.split("/")[0]}`,
    logPath,
    startedAt: new Date("2026-05-24T00:00:00.000Z"),
  };
}

afterEach(() => {
  delete process.env.DEN_DAEMONS_FILE;
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("daemon registry persistence", () => {
  it("loads records even when the writer denPid is no longer alive", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          denPid: 999999,
          daemons: [
            {
              ...daemon("shop/api"),
              startedAt: "2026-05-24T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { loadDaemonsFromFile, listDaemons } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    loadDaemonsFromFile();

    expect(listDaemons().map((record) => record.address)).toEqual(["shop/api"]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("refreshes list reads from disk so web sees CLI-started daemons", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;
    fs.writeFileSync(file, JSON.stringify({ denPid: 1, daemons: [] }), "utf-8");

    const { loadDaemonsFromFile, listDaemons } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    loadDaemonsFromFile();
    expect(listDaemons()).toEqual([]);

    fs.writeFileSync(
      file,
      JSON.stringify({
        denPid: 2,
        daemons: [
          { ...daemon("infra-stack"), startedAt: "2026-05-24T00:00:00.000Z" },
        ],
      }),
      "utf-8",
    );

    expect(listDaemons().map((record) => record.address)).toEqual([
      "infra-stack",
    ]);
  });

  it("preserves unrelated records when registering a daemon", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;
    fs.writeFileSync(
      file,
      JSON.stringify({
        denPid: 1,
        daemons: [
          { ...daemon("shop/api"), startedAt: "2026-05-24T00:00:00.000Z" },
        ],
      }),
      "utf-8",
    );

    const { registerDaemon, listDaemons } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    registerDaemon(daemon("shop-web/web"));

    expect(
      listDaemons()
        .map((record) => record.address)
        .sort(),
    ).toEqual(["shop-web/web", "shop/api"]);
  });

  it("preserves unrelated records when unregistering a daemon", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;
    fs.writeFileSync(
      file,
      JSON.stringify({
        denPid: 1,
        daemons: [
          { ...daemon("shop/api"), startedAt: "2026-05-24T00:00:00.000Z" },
          {
            ...daemon("shop-web/web"),
            startedAt: "2026-05-24T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );

    const { unregisterDaemon, listDaemons } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    unregisterDaemon("shop/api");

    expect(listDaemons().map((record) => record.address)).toEqual([
      "shop-web/web",
    ]);
  });

  it("attachDaemonOwner adds workspace without duplicating", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;

    const {
      registerDaemon,
      attachDaemonOwner,
      findDaemonByAddress,
      loadDaemonsFromFile,
    } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    loadDaemonsFromFile();
    registerDaemon({
      ...daemon("shop/api"),
      branch: "main",
      workspaces: ["default"],
    });
    attachDaemonOwner("shop/api", "feat-x");
    attachDaemonOwner("shop/api", "feat-x");

    expect(findDaemonByAddress("shop/api")?.workspaces).toEqual([
      "default",
      "feat-x",
    ]);
  });

  it("detachDaemonOwner keeps daemon until last owner", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;

    const {
      registerDaemon,
      detachDaemonOwner,
      findDaemonByAddress,
      loadDaemonsFromFile,
    } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    loadDaemonsFromFile();
    registerDaemon({
      ...daemon("shop/api"),
      workspaces: ["default", "feat-x"],
    });

    expect(detachDaemonOwner("shop/api", "feat-x")).toEqual({
      removed: false,
      remaining: ["default"],
    });
    expect(findDaemonByAddress("shop/api")?.workspaces).toEqual(["default"]);

    expect(detachDaemonOwner("shop/api", "default")).toEqual({
      removed: true,
      remaining: [],
    });
    expect(findDaemonByAddress("shop/api")).toBeUndefined();
  });

  it("findDaemonConflict hard-blocks identity mismatch", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;

    const { registerDaemon, findDaemonConflict, loadDaemonsFromFile } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    loadDaemonsFromFile();
    registerDaemon({
      ...daemon("shop/api"),
      repoPath: "/repos/shop-main",
      branch: "main",
      workspaces: ["default"],
    });

    const conflict = findDaemonConflict({
      address: "shop/api",
      repoPath: "/repos/shop-feat",
      branch: "feat/x",
      repoName: "shop",
    });

    expect(conflict).not.toBeNull();
    expect(conflict!.reason).toBe("identity_mismatch");
    expect(conflict!.owners).toEqual(["default"]);
  });

  it("findDaemonConflict allows same identity (share)", async () => {
    const file = makeTempFile("daemons.json");
    process.env.DEN_DAEMONS_FILE = file;

    const { registerDaemon, findDaemonConflict, loadDaemonsFromFile } =
      await import("../../../src/shared/environment-manager/service-runner.js");

    loadDaemonsFromFile();
    registerDaemon({
      ...daemon("shop/api"),
      repoPath: "/repos/shop",
      branch: "main",
      workspaces: ["default"],
    });

    expect(
      findDaemonConflict({
        address: "shop/api",
        repoPath: "/repos/shop",
        branch: "main",
        repoName: "shop",
      }),
    ).toBeNull();
  });
});
