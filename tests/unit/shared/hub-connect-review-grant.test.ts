/**
 * Issue 648 (one approval for the connection, every link and every create;
 * the contract agreed with Hub, on the issue): what Den sends Hub's Connect
 * page (`review=1&projects=<base64url JSON>`, at most 50 projects and 6 KB,
 * keys [a-z0-9-]{1,64} once each, never the catch-all `default`), and how
 * it checks Hub's answer (`review` on POST /connect/token): version 1, the
 * hash of what was sent, every key back exactly once. Anything else: Den
 * falls back to issue 646's flow. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import {
  REVIEW_MAX_BYTES,
  REVIEW_MAX_PROJECTS,
  parseGrantReview,
  reviewParam,
} from "../../../src/shared/hub-connect-review-grant.js";

const P = [
  { key: "north", name: "North", repos: ["acme/web"] },
  { key: "south", name: "South", repos: [] },
  { key: "east", name: "East", repos: ["acme/east"] },
];
const ok = () => {
  const r = reviewParam(P);
  if (!r.ok) throw new Error(r.why);
  return r;
};
const WEB = { id: "proj_web1", slug: "web", name: "Web" };

describe("issue 648: what Connect sends", () => {
  it("base64url JSON of the projects, and the sha256 of what is sent", () => {
    const r = ok();
    expect(r.param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      JSON.parse(Buffer.from(r.param, "base64url").toString("utf8")),
    ).toEqual(P);
    expect(r.hash).toBe(createHash("sha256").update(r.param).digest("hex"));
    expect(r.keys).toEqual(["north", "south", "east"]);
  });

  it("the catch-all `default` is never sent", () => {
    const r = reviewParam([
      ...P,
      { key: "default", name: "Default", repos: [] },
    ]);
    expect(r.ok && r.keys).toEqual(["north", "south", "east"]);
  });

  it("past 50 projects or 6 KB: falls back, saying why", () => {
    expect(REVIEW_MAX_PROJECTS).toBe(50);
    expect(REVIEW_MAX_BYTES).toBe(6144);
    const many = Array.from({ length: 51 }, (_, i) => ({
      key: `p${i}`,
      name: `P${i}`,
      repos: [],
    }));
    expect(reviewParam(many)).toEqual({
      ok: false,
      why: "more than 50 projects",
    });
    const big = Array.from({ length: 40 }, (_, i) => ({
      key: `p${i}`,
      name: "N".repeat(150),
      repos: [],
    }));
    expect(reviewParam(big)).toEqual({
      ok: false,
      why: "the list is over 6 KB",
    });
  });

  it("a key Hub can't match exactly, or one twice: falls back", () => {
    expect(reviewParam([{ key: "North", name: "N", repos: [] }])).toEqual({
      ok: false,
      why: 'project "North" has a name Hub can\'t match (a-z, 0-9 and -, at most 64)',
    });
    expect(reviewParam([P[0]!, P[0]!])).toEqual({
      ok: false,
      why: 'project "north" is listed twice',
    });
    expect(reviewParam([])).toEqual({ ok: false, why: "no projects to link" });
  });
});

describe("issue 648: Hub's answer", () => {
  const sent = () => {
    const r = ok();
    return { hash: r.hash, keys: r.keys };
  };
  const good = (hash: string) => ({
    version: 1,
    projects_hash: hash,
    links: [
      { key: "north", project: WEB, how: "linked" },
      {
        key: "east",
        project: { id: "p_e", slug: "east", name: "East" },
        how: "created",
      },
    ],
    skipped: [{ key: "south", why: "person", detail: "skipped" }],
  });

  it("every key back once: the links and the skips", () => {
    const s = sent();
    expect(parseGrantReview(good(s.hash), s)).toEqual({
      ok: true,
      links: [
        { key: "north", project: WEB, how: "linked" },
        {
          key: "east",
          project: { id: "p_e", slug: "east", name: "East" },
          how: "created",
        },
      ],
      skipped: [{ key: "south", why: "person", detail: "skipped" }],
    });
  });

  it("no review (an older Hub): falls back", () => {
    expect(parseGrantReview(undefined, sent())).toEqual({
      ok: false,
      why: "this Hub doesn't link projects in Connect yet",
    });
  });

  it("a hash that isn't what Den sent: dropped", () => {
    const s = sent();
    expect(parseGrantReview(good("0".repeat(64)), s)).toEqual({
      ok: false,
      why: "Hub's answer is for another list of projects",
    });
  });

  it("a key missing, twice, or never sent: dropped", () => {
    const s = sent();
    const missing = { ...good(s.hash), skipped: [] };
    expect(parseGrantReview(missing, s).ok).toBe(false);
    const twice = {
      ...good(s.hash),
      skipped: [
        { key: "south", why: "person" },
        { key: "north", why: "failed" },
      ],
    };
    expect(parseGrantReview(twice, s).ok).toBe(false);
    const stranger = {
      ...good(s.hash),
      skipped: [
        { key: "south", why: "person" },
        { key: "west", why: "person" },
      ],
    };
    expect(parseGrantReview(stranger, s).ok).toBe(false);
  });

  it("a bad shape (version, how, why, project fields): dropped", () => {
    const s = sent();
    expect(parseGrantReview({ ...good(s.hash), version: 2 }, s).ok).toBe(false);
    const how = good(s.hash);
    (how.links[0] as { how: string }).how = "moved";
    expect(parseGrantReview(how, s).ok).toBe(false);
    const why = good(s.hash);
    (why.skipped[0] as { why: string }).why = "bored";
    expect(parseGrantReview(why, s).ok).toBe(false);
    const proj = good(s.hash);
    (proj.links[0] as { project: unknown }).project = { id: "x" };
    expect(parseGrantReview(proj, s).ok).toBe(false);
  });

  it("permission is a reason a create was left out", () => {
    const s = sent();
    const r = parseGrantReview(
      {
        ...good(s.hash),
        links: [{ key: "north", project: WEB, how: "linked" }],
        skipped: [
          { key: "south", why: "person" },
          {
            key: "east",
            why: "permission",
            detail: "members can't create projects",
          },
        ],
      },
      s,
    );
    expect(r.ok && r.skipped.map((x) => x.why)).toEqual([
      "person",
      "permission",
    ]);
  });
});
