/**
 * `create <name> [dir] --yes --json` (ON-2): prompt-free, one JSON object
 * on stdout, safe to re-run. A dir that already holds this distribution is
 * ok with existed: true and nothing written; a different non-empty dir is
 * an error with a fix and a question.
 *
 * The web port: when the default is in use, create picks the next free one
 * above it (never a reserved Den port) and writes it to the new
 * distribution's config/local/user.yml. No test here probes the real
 * default: each passes a start port (and, except one, a fake "in use").
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import {
  createResult,
  existingDistribution,
  parseCreateArgs,
  runCreate,
  startPortFromEnv,
  type CreatePortOptions,
} from "../../../src/ui/cli/create.js";
import { pickFreePort, portInUse } from "../../../src/shared/port-pick.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-create-json-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A start port and an "in use" that says every port is free. */
const FREE: CreatePortOptions = { startPort: 41000, inUse: async () => false };

async function stdoutOf(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string }> {
  const write = process.stdout.write;
  const log = console.log;
  let out = "";
  process.stdout.write = ((c: string) => {
    out += c;
    return true;
  }) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => {
    out += `${a.join(" ")}\n`;
  };
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = write;
    console.log = log;
  }
}

/** Listen on a free localhost port until closed. */
function occupy(): Promise<net.Server & { port: number }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.destroy());
    s.listen(0, "localhost", () =>
      resolve(
        Object.assign(s, { port: (s.address() as net.AddressInfo).port }),
      ),
    );
  });
}

describe("create --yes --json", () => {
  it("parses --yes, --json and --port (it threw on unknown flags)", () => {
    expect(parseCreateArgs(["acme", "--yes", "--json"], tmp)).toMatchObject({
      name: "acme",
      dir: path.join(tmp, "acme"),
      yes: true,
      json: true,
    });
    expect(parseCreateArgs(["acme", "--port=4100"], tmp).port).toBe(4100);
    expect(() => parseCreateArgs(["acme", "--port", "x"], tmp)).toThrow(
      /--port must be a port number/,
    );
  });

  it("prints exactly one JSON object, then answers existed: true on a re-run", async () => {
    const dir = path.join(tmp, "acme");
    const first = await stdoutOf(() =>
      runCreate(["acme", dir, "--yes", "--json"], tmp, FREE),
    );
    expect(first.code).toBe(0);
    expect(first.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(first.out)).toEqual({
      ok: true,
      dir,
      cli: "acme",
      existed: false,
      files: 10,
      port: 41000,
      next: [
        "cd acme",
        "npm install",
        "./bin/acme repo add <path|git-url> --json",
      ],
    });
    // The start port was free: nothing is written for it.
    expect(fs.existsSync(path.join(dir, "config", "local", "user.yml"))).toBe(
      false,
    );
    const den = fs.readFileSync(path.join(dir, "den.yml"), "utf-8");

    const again = await stdoutOf(() =>
      runCreate(["acme", dir, "--yes", "--json"], tmp, FREE),
    );
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({
      ok: true,
      dir,
      existed: true,
    });
    expect(fs.readFileSync(path.join(dir, "den.yml"), "utf-8")).toBe(den);
  });

  it("a non-empty dir that is not this distribution: ok false, a fix and a question", async () => {
    const dir = path.join(tmp, "busy");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    const r = await createResult(
      parseCreateArgs(["acme", dir, "--yes"], tmp),
      tmp,
      undefined,
      FREE,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is not empty/);
    expect(r.fix).toMatch(/create acme .*acme-den --yes --json$/);
    expect(r.ask).toMatch(/new or empty folder/);
    expect(fs.readdirSync(dir)).toEqual(["notes.txt"]);
  });

  it("another distribution in the dir is not this one", async () => {
    const dir = path.join(tmp, "d");
    const make = (name: string) =>
      createResult(parseCreateArgs([name, dir], tmp), tmp, undefined, FREE);
    expect((await make("acme")).ok).toBe(true);
    expect(existingDistribution(dir, { name: "acme" })).toBe(true);
    expect(existingDistribution(dir, { name: "other" })).toBe(false);
    expect(existingDistribution(dir, { name: "acme", cli: "ac" })).toBe(false);
    expect((await make("other")).ok).toBe(false);
  });

  it("a bad name or flag is JSON too, with a question or a fix", async () => {
    const bad = await stdoutOf(() =>
      runCreate(["Bad_Name", "--json"], tmp, FREE),
    );
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/must start with a lower-case letter/),
      ask: expect.any(String),
    });
    const flag = await stdoutOf(() =>
      runCreate(["acme", "--nope", "--json"], tmp, FREE),
    );
    expect(JSON.parse(flag.out)).toMatchObject({
      ok: false,
      error: "unknown flag --nope",
      fix: expect.stringMatching(/--yes --json$/),
    });
  });
});

describe("create picks a free web port", () => {
  it("the start port in use: the next free one, written to config/local/user.yml, said in JSON and to people", async () => {
    const held = await occupy();
    try {
      // `held` stands in for the default (7777, which no test touches).
      const opts: CreatePortOptions = { startPort: held.port };
      const dir = path.join(tmp, "second");
      const j = await stdoutOf(() =>
        runCreate(["acme", dir, "--yes", "--json"], tmp, opts),
      );
      const r = JSON.parse(j.out);
      expect(r).toMatchObject({
        ok: true,
        existed: false,
        files: 11,
        portPicked: {
          wanted: held.port,
          file: path.join("config", "local", "user.yml"),
        },
      });
      expect(r.port).toBeGreaterThan(held.port);
      expect(await portInUse(r.port)).toBe(false);
      const user = parseYaml(
        fs.readFileSync(path.join(dir, "config", "local", "user.yml"), "utf-8"),
      );
      expect(user).toEqual({ web: { port: r.port } });
      // config/local/ is the distribution's gitignored, per-person layer.
      expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toMatch(
        /^config\/local\/$/m,
      );
      // A re-run reports the port it is set to and picks nothing.
      const again = await createResult(
        parseCreateArgs(["acme", dir], tmp),
        tmp,
        undefined,
        opts,
      );
      expect(again).toMatchObject({ ok: true, existed: true, port: r.port });

      // People see it too.
      const human = await stdoutOf(() =>
        runCreate(["acme", path.join(tmp, "third")], tmp, opts),
      );
      expect(human.code).toBe(0);
      expect(human.out).toMatch(
        new RegExp(
          `Web UI port: \\d+ \\(${held.port} is in use here; set in config/local/user.yml\\)`,
        ),
      );
    } finally {
      await new Promise((r) => held.close(r));
    }
  });

  it("never picks a reserved Den port, and --port is taken as given", async () => {
    const busy = new Set([7777]);
    const seen: number[] = [];
    const inUse = async (p: number) => {
      seen.push(p);
      return busy.has(p);
    };
    expect(
      await pickFreePort({ start: 7777, reserved: [7778, 7779], inUse }),
    ).toBe(7780);
    expect(seen).toEqual([7777, 7780]); // reserved ports are not even probed
    expect(await pickFreePort({ start: 7777, inUse })).toBe(7779); // 7778 is Den's
    expect(
      await pickFreePort({ start: 7777, span: 2, inUse: async () => true }),
    ).toBeNull();

    const dir = path.join(tmp, "explicit");
    const r = await createResult(
      parseCreateArgs(["acme", dir, "--port", "4321"], tmp),
      tmp,
      undefined,
      { startPort: 41000, inUse: async () => true },
    );
    expect(r).toMatchObject({ ok: true, port: 4321 });
    expect(r.portPicked).toBeUndefined();
    expect(
      parseYaml(
        fs.readFileSync(path.join(dir, "config", "local", "user.yml"), "utf-8"),
      ),
    ).toEqual({ web: { port: 4321 } });
  });

  it("DEN_WEB_PORT_START sets the start port for the CLI", () => {
    expect(startPortFromEnv({ DEN_WEB_PORT_START: "41234" })).toBe(41234);
    expect(startPortFromEnv({ DEN_WEB_PORT_START: "nope" })).toBeUndefined();
    expect(startPortFromEnv({})).toBeUndefined();
  });
});
