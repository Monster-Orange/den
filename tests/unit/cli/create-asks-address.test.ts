/**
 * D80 (#173): `create` asks for the install's address (web.url) when a
 * person is at the prompt and --url is absent, and proposes one.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import {
  proposeWebUrl,
  runCreate,
  type CreatePortOptions,
} from "../../../src/ui/cli/create.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-create-addr-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
const FREE: CreatePortOptions = { startPort: 41100, inUse: async () => false };

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = log;
  });
}

function savedUrl(dir: string): string | undefined {
  const f = path.join(dir, "config/local/user.yml");
  return fs.existsSync(f)
    ? parseYaml(fs.readFileSync(f, "utf-8"))?.web?.url
    : undefined;
}

describe("proposeWebUrl", () => {
  it("first install: the plain name; later installs: <product>.<machine>.<domain>", () => {
    expect(proposeWebUrl({ cli: "acme", machine: "box", later: false })).toBe(
      "https://acme",
    );
    expect(
      proposeWebUrl({
        cli: "acme",
        machine: "box",
        domain: "example.com",
        later: true,
      }),
    ).toBe("https://acme.box.example.com");
  });
});

describe("create asks for the address", () => {
  it("asks when interactive and no --url, proposing a default; empty answer takes it", async () => {
    const dir = path.join(tmp, "acme");
    const asked: { q: string; def: string }[] = [];
    const code = await quiet(() =>
      runCreate(["acme", dir], tmp, FREE, {
        interactive: true,
        machine: "box",
        ask: async (q, def) => {
          asked.push({ q, def });
          return "";
        },
      }),
    );
    expect(code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0].def).toBe("https://acme");
    expect(savedUrl(dir)).toBe("https://acme");
  });

  it("takes the person's own answer", async () => {
    const dir = path.join(tmp, "acme");
    await quiet(() =>
      runCreate(["acme", dir], tmp, FREE, {
        interactive: true,
        ask: async () => "https://acme.example.com",
      }),
    );
    expect(savedUrl(dir)).toBe("https://acme.example.com");
  });

  // A later install's domain is the distribution's own: the first
  // install's, else the distribution's edge domain. Never a made-up one.
  const askedFor = async (dir: string): Promise<string> => {
    let def = "";
    await quiet(() =>
      runCreate(["acme", dir], tmp, FREE, {
        interactive: true,
        machine: "box2",
        ask: async (_q, d) => ((def = d), ""),
      }),
    );
    return def;
  };

  it("a later install takes the first install's domain", async () => {
    const first = path.join(tmp, "acme");
    await quiet(() =>
      runCreate(
        ["acme", first, "--url", "https://acme.dev.example.com"],
        tmp,
        FREE,
      ),
    );
    expect(await askedFor(path.join(tmp, "acme-2"))).toBe(
      "https://acme.box2.dev.example.com",
    );
  });

  it("else the distribution's edge domain, never a literal .local, and never a loopback one (issue 666)", async () => {
    const first = path.join(tmp, "acme");
    await quiet(() => runCreate(["acme", first, "--yes"], tmp, FREE));
    // The first install has no address; its edge is acme.localhost, which
    // only that machine opens: it is no domain for an address.
    const def = await askedFor(path.join(tmp, "acme-2"));
    expect(def).toBe("https://acme.box2");
    expect(def).not.toMatch(/\.local$/);
    expect(def).not.toMatch(/localhost/);
  });

  it("never asks with --url, --yes, --json or when not interactive", async () => {
    let n = 0;
    const ask = async () => (n++, "");
    const opts = { interactive: true, ask };
    await quiet(() =>
      runCreate(
        ["a1", path.join(tmp, "a1"), "--url", "https://a1.example.com"],
        tmp,
        FREE,
        opts,
      ),
    );
    await quiet(() =>
      runCreate(["a2", path.join(tmp, "a2"), "--yes"], tmp, FREE, opts),
    );
    await quiet(() =>
      runCreate(["a3", path.join(tmp, "a3"), "--json"], tmp, FREE, opts),
    );
    await quiet(() =>
      runCreate(["a4", path.join(tmp, "a4")], tmp, FREE, { ask }),
    );
    expect(n).toBe(0);
  });
});
