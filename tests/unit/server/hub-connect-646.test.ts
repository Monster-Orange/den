/**
 * Issue 646 (point 1): Connect sends Hub's Connect page this Den's
 * projects' repos (`repos=<owner/repo>,…`, at most 50, the same list Den
 * reports for its projects), so Hub ranks the person's companies by them
 * and pre-selects one clear match. Hub does the ranking with the person's
 * own session; Den only sends the list. An older Hub ignores the
 * parameter. Fakes for Hub; invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  CONNECT_REPOS_MAX,
  HubConnect,
  connectRepos,
  type HubConnectDeps,
} from "../../../src/ui/server/hub-connect.js";

const ORIGIN = "http://localhost:7300";
const HUB = "https://hub.example.test";

function hc(over: Partial<HubConnectDeps> = {}) {
  return new HubConnect({
    now: () => 1,
    config: () => null,
    exchange: async () => ({ token: "hubi_TESTONLY_646" }),
    revoke: async () => true,
    store: async () => ({ kind: "file", source: "file:/x", where: "/x" }),
    forget: async () => undefined,
    readToken: async () => null,
    readUser: () => ({}),
    writeUser: () => undefined,
    installLabel: () => "den on box",
    ...over,
  });
}

const q = (h: HubConnect) => {
  const r = h.start(ORIGIN, HUB);
  if (!r.ok) throw new Error(r.error);
  return new URL(r.location).searchParams;
};

describe("issue 646: Connect sends the projects' repos", () => {
  it("repos=owner/repo,… from every project, once each", () => {
    const h = hc({ repos: () => ["north/web", "north/api", "north/web"] });
    expect(q(h).get("repos")).toBe("north/web,north/api");
  });

  it("none: no repos parameter (an older Hub sees the same URL as before)", () => {
    expect(q(hc({ repos: () => [] })).has("repos")).toBe(false);
    expect(q(hc()).has("repos")).toBe(false);
  });

  it("at most 50, and only owner/repo shapes", () => {
    const many = Array.from({ length: 70 }, (_, i) => `org/r${i}`);
    const sent = q(hc({ repos: () => [...many, "not a repo", "a/b/c"] }))
      .get("repos")!
      .split(",");
    expect(CONNECT_REPOS_MAX).toBe(50);
    expect(sent).toHaveLength(50);
    expect(sent[0]).toBe("org/r0");
    expect(sent).not.toContain("not a repo");
  });

  it("connectRepos: every project's repos, lower case, the server scope never", () => {
    const repos: Record<string, string[]> = {
      north: ["North/Web"],
      south: ["south/api", "north/web"],
      "den-server": ["secret/ops"],
    };
    expect(
      connectRepos(
        Object.keys(repos),
        (ws) => repos[ws] ?? [],
        (ws) => ws.endsWith("-server"),
      ),
    ).toEqual(["north/web", "south/api"]);
  });

  it("a repo list that throws never stops Connect", () => {
    const h = hc({
      repos: () => {
        throw new Error("boom");
      },
    });
    expect(q(h).has("repos")).toBe(false);
  });
});
