/**
 * Issue 130: the daemons file (every service Den started, its process group
 * and owners) never loses records silently.
 *  - A corrupt or wrongly shaped file is moved aside (daemons.json.corrupt-
 *    <time>), never overwritten, with a warning naming where it went; the
 *    next record starts a fresh file.
 *  - A file Den can't read (not missing) refuses the change: a save then
 *    would overwrite records it never saw.
 *  - A save that fails throws, so `up` can't say a service started when its
 *    record wasn't kept.
 * Real files in a temporary folder; invented names.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import {
  listDaemons,
  loadDaemonsFromFile,
  registerDaemon,
} from "../../../src/shared/environment-manager/service-runner.js";

let dir: string;
let file: string;
const was = process.env.DEN_DAEMONS_FILE;
let warned: string[];

const record = (address: string) => ({
  address,
  repoName: address.split("/")[0],
  subsystem: address.split("/")[1],
  repoPath: path.join(dir, address.split("/")[0]),
  branch: null,
  workspaces: ["default"],
  logPath: path.join(dir, "x.log"),
  startedAt: new Date("2030-01-01T12:00:00Z"),
  containers: [],
});
const saved = () =>
  (
    JSON.parse(fs.readFileSync(file, "utf-8")) as {
      daemons: { address: string }[];
    }
  ).daemons.map((d) => d.address);
const asides = () =>
  fs.readdirSync(dir).filter((n) => n.startsWith("daemons.json.corrupt-"));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-daemons-130-"));
  file = path.join(dir, "daemons.json");
  process.env.DEN_DAEMONS_FILE = file;
  warned = [];
  jest.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warned.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* gone */
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (was === undefined) delete process.env.DEN_DAEMONS_FILE;
  else process.env.DEN_DAEMONS_FILE = was;
});

describe("the daemons file keeps every record", () => {
  it("records of other services stay when one is added (guard)", () => {
    registerDaemon(record("shop/api"));
    registerDaemon(record("shop/db"));
    expect(saved().sort()).toEqual(["shop/api", "shop/db"]);
  });

  it("a corrupt file is moved aside, never overwritten, with a warning; the next record starts a fresh file", () => {
    const bytes = '{"denPid": 1, "daemons": [{"address": "shop/api", ';
    fs.writeFileSync(file, bytes);
    registerDaemon(record("shop/web"));
    const [aside] = asides();
    expect(aside).toBeDefined();
    expect(fs.readFileSync(path.join(dir, aside), "utf-8")).toBe(bytes);
    expect(saved()).toEqual(["shop/web"]);
    expect(warned.join("\n")).toContain(aside);
  });

  it("a file of the wrong shape is moved aside too, not read as empty", () => {
    fs.writeFileSync(file, JSON.stringify({ denPid: 1, daemons: 5 }));
    loadDaemonsFromFile();
    expect(asides()).toHaveLength(1);
    expect(listDaemons()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify("shop/api"));
    loadDaemonsFromFile();
    expect(asides()).toHaveLength(2);
  });

  it("a file Den can't read refuses the change and writes nothing", () => {
    fs.mkdirSync(file); // not a file: reading it fails, and it isn't missing
    expect(() => registerDaemon(record("shop/web"))).toThrow(
      /daemons file .*can't be read/i,
    );
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(asides()).toEqual([]);
  });

  const asRoot = process.getuid?.() === 0;
  (asRoot ? it.skip : it)(
    "a save that fails throws, naming the file, and leaves the old one as it was",
    () => {
      registerDaemon(record("shop/api"));
      const before = fs.readFileSync(file, "utf-8");
      fs.chmodSync(dir, 0o500); // no new files here: the save can't land
      expect(() => registerDaemon(record("shop/web"))).toThrow(
        /couldn't save .*daemons\.json/i,
      );
      fs.chmodSync(dir, 0o700);
      expect(fs.readFileSync(file, "utf-8")).toBe(before);
    },
  );
});
