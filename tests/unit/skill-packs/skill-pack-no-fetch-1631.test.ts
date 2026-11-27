import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  agentSkillPacks,
  readSkillPacksConfig,
} from "../../../src/shared/skill-packs/launch";
import { readPacks } from "../../../src/shared/skill-packs/pin";
import { skillPacksPrompt } from "../../../src/shared/agents/den-claude";

const PACKS_DIR = path.resolve(__dirname, "../../../skill-packs");

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-nofetch-"));
  dirs.push(d);
  return d;
}

const calls: string[] = [];
const refuse = (what: string) => () => {
  calls.push(what);
  throw new Error(`network call: ${what}`);
};
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = refuse("fetch") as unknown as typeof fetch;
  jest.spyOn(http, "request").mockImplementation(refuse("http.request"));
  jest.spyOn(http, "get").mockImplementation(refuse("http.get"));
  jest.spyOn(https, "request").mockImplementation(refuse("https.request"));
  jest.spyOn(https, "get").mockImplementation(refuse("https.get"));
  jest.spyOn(net, "connect").mockImplementation(refuse("net.connect"));
  jest
    .spyOn(net, "createConnection")
    .mockImplementation(refuse("net.createConnection"));
  jest.spyOn(dns, "lookup").mockImplementation(refuse("dns.lookup"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    for (const f of fs.readdirSync(d, { recursive: true }) as string[])
      fs.chmodSync(path.join(d, f), 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("issue 1631: the launch path never fetches", () => {
  it("reading the config, building the pack folder and writing the prompt make no network call", () => {
    const packs = readPacks(PACKS_DIR);
    const got = agentSkillPacks({
      stateDir: tmp(),
      runtimeId: "den-claude",
      install: readSkillPacksConfig(undefined, undefined, packs),
      persona: undefined,
      agent: undefined,
      claudeConfigDir: tmp(),
      packsDir: PACKS_DIR,
    });
    expect(got.packs.map((p) => p.name)).toEqual(["pstack"]);
    expect(skillPacksPrompt(got.packs)).toContain("pstack");
    expect(calls).toEqual([]);
  });

  it("the stubs do refuse, so the test above can fail", () => {
    expect(() => http.get("http://example.test")).toThrow("network call");
    expect(() => void fetch("http://example.test")).toThrow("network call");
    expect(calls).toEqual(["http.get", "fetch"]);
  });
});
