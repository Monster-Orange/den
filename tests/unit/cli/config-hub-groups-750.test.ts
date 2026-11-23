/**
 * Issue 750: `config hub.groups=auto|on|off` and
 * `config hub.groups_cache_seconds=N` write user.yml's hub block, checked
 * as Settings checks them (hub.ts patchHubGroups), leaving the rest of the
 * block (the Hub's address) alone. Den's groups read takes the new value
 * at its next request, with no restart: the route's deps are read from
 * config on each request. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

type ConfigCmd = typeof import("../../../src/ui/cli/config-command.js");
type GroupsRoutes =
  typeof import("../../../src/ui/server/hub-groups-routes.js");

const HUB = "https://hub.example.test";
let root = "";
const savedRoot = process.env.DEN_ROOT;
let cli: ConfigCmd;
let routes: GroupsRoutes;

const userYml = () => path.join(root, "config", "local", "user.yml");
const readUser = () =>
  (yaml.parse(fs.readFileSync(userYml(), "utf8")) ?? {}) as Record<
    string,
    unknown
  >;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-750c-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  fs.writeFileSync(userYml(), yaml.stringify({ hub: { url: HUB } }));
  process.env.DEN_ROOT = root;
  cli = await import("../../../src/ui/cli/config-command.js");
  routes = await import("../../../src/ui/server/hub-groups-routes.js");
});
afterAll(() => {
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

/** What Den's groups read would use now, read fresh (no restart). */
const live = async () => {
  const d = await routes.defaultHubGroupsDeps();
  return { mode: d.mode(), cache: d.cacheSeconds() };
};

describe("issue 750: config hub.groups and hub.groups_cache_seconds", () => {
  it("are config keys", () => {
    expect(cli.configKeyNames()).toEqual(
      expect.arrayContaining(["hub.groups", "hub.groups_cache_seconds"]),
    );
  });

  it("auto is the default; each value is written to user.yml and read at once", async () => {
    expect(await live()).toEqual({ mode: "auto", cache: 30 });
    for (const v of ["on", "off", "auto"] as const) {
      await cli.cmdConfig([`hub.groups=${v}`]);
      expect((readUser().hub as Record<string, unknown>).groups).toBe(v);
      expect((await live()).mode).toBe(v);
    }
    // The Hub's address is kept.
    expect((readUser().hub as Record<string, unknown>).url).toBe(HUB);
  });

  it("true and false are written as on and off", async () => {
    await cli.cmdConfig(["hub.groups=true"]);
    expect((readUser().hub as Record<string, unknown>).groups).toBe("on");
    await cli.cmdConfig(["hub.groups=false"]);
    expect((readUser().hub as Record<string, unknown>).groups).toBe("off");
  });

  it("the cache's seconds: 5 to 3600, whole seconds", async () => {
    await cli.cmdConfig(["hub.groups_cache_seconds=90"]);
    expect(
      (readUser().hub as Record<string, unknown>).groups_cache_seconds,
    ).toBe(90);
    expect((await live()).cache).toBe(90);
    for (const bad of ["4", "3601", "7.5", "soon"])
      await expect(
        cli.cmdConfig([`hub.groups_cache_seconds=${bad}`]),
      ).rejects.toThrow(/hub\.groups_cache_seconds/);
    expect(
      (readUser().hub as Record<string, unknown>).groups_cache_seconds,
    ).toBe(90);
  });

  it("junk is refused and nothing is written", async () => {
    const before = fs.readFileSync(userYml(), "utf8");
    for (const bad of ["maybe", "1", "ON"])
      await expect(cli.cmdConfig([`hub.groups=${bad}`])).rejects.toThrow(
        /hub\.groups must be auto, on or off/,
      );
    expect(fs.readFileSync(userYml(), "utf8")).toBe(before);
  });

  it("config rm clears each back to its default", async () => {
    await cli.cmdConfig(["rm", "hub.groups"]);
    await cli.cmdConfig(["rm", "hub.groups_cache_seconds"]);
    expect(readUser().hub).toEqual({ url: HUB });
    expect(await live()).toEqual({ mode: "auto", cache: 30 });
  });
});
