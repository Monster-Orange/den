/**
 * Issue 620: a session that isn't a Den agent can put a yes/no (or a few
 * named choices) in front of the person. The ask is bound to the process
 * that filed it (pid and start time), only that process reads its answer,
 * the person answers it, it runs nothing, and it expires.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  answerAsk,
  askFor,
  fileAsk,
  openAsks,
  parseAskInput,
  SessionAskStore,
  type AskCaller,
} from "../../../src/shared/session-asks.js";

const ME: AskCaller = { pid: 4242, started: "Sun Nov 22 17:00:00 2026" };
const LIMITS = { openPerSession: 2, openTotal: 3, ttlMs: 60_000 };
let dir: string;
let store: SessionAskStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-620-"));
  store = new SessionAskStore(path.join(dir, "session-asks.json"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 620: what an ask may say", () => {
  it("a question, yes/no by default, and the session's own label", () => {
    expect(parseAskInput({ question: "Ship it?", session: "builder" })).toEqual(
      {
        ok: true,
        input: {
          question: "Ship it?",
          choices: ["yes", "no"],
          session: "builder",
        },
      },
    );
  });

  it("two to four named choices", () => {
    const r = parseAskInput({ question: "Which?", choices: ["a", "b", "c"] });
    expect(r).toMatchObject({ ok: true, input: { choices: ["a", "b", "c"] } });
    expect(parseAskInput({ question: "Q", choices: ["a"] }).ok).toBe(false);
    expect(
      parseAskInput({ question: "Q", choices: ["a", "b", "c", "d", "e"] }).ok,
    ).toBe(false);
    expect(parseAskInput({ question: "Q", choices: ["a", "a"] }).ok).toBe(
      false,
    );
  });

  it("refuses an empty or long question, a long label or choice", () => {
    expect(parseAskInput({ question: "  " }).ok).toBe(false);
    expect(parseAskInput({ question: "x".repeat(301) }).ok).toBe(false);
    expect(parseAskInput({ question: "Q", session: "s".repeat(61) }).ok).toBe(
      false,
    );
    expect(
      parseAskInput({ question: "Q", choices: ["y".repeat(41), "n"] }).ok,
    ).toBe(false);
  });
});

describe("issue 620: filing, reading and answering", () => {
  it("files an open ask bound to its caller", () => {
    const r = fileAsk(
      store,
      ME,
      { question: "Ship it?", choices: ["yes", "no"] },
      LIMITS,
      1_000,
    );
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    expect(openAsks(store, 1_000).map((a) => a.id)).toEqual([id]);
    expect(askFor(store, id, ME, 1_000)).toMatchObject({ state: "open" });
  });

  it("only the process that filed it reads it: another pid or start time sees none", () => {
    const { id } = fileAsk(
      store,
      ME,
      { question: "Q", choices: ["yes", "no"] },
      LIMITS,
      1_000,
    ) as { id: string };
    expect(
      askFor(store, id, { pid: 4243, started: ME.started }, 1_000),
    ).toBeNull();
    expect(
      askFor(store, id, { pid: 4242, started: "other" }, 1_000),
    ).toBeNull();
    expect(askFor(store, "nope", ME, 1_000)).toBeNull();
  });

  it("the person's answer is one of its choices; it then leaves the open list", () => {
    const { id } = fileAsk(
      store,
      ME,
      { question: "Q", choices: ["yes", "no"] },
      LIMITS,
      1_000,
    ) as { id: string };
    expect(answerAsk(store, id, "maybe", 2_000).ok).toBe(false);
    expect(answerAsk(store, id, "yes", 2_000)).toMatchObject({ ok: true });
    expect(askFor(store, id, ME, 2_000)).toMatchObject({
      state: "answered",
      answer: "yes",
    });
    expect(openAsks(store, 2_000)).toEqual([]);
    // Answered once: a second answer is refused.
    expect(answerAsk(store, id, "no", 3_000).ok).toBe(false);
  });

  it("past its time it expires: no longer open, can't be answered", () => {
    const { id } = fileAsk(
      store,
      ME,
      { question: "Q", choices: ["yes", "no"] },
      LIMITS,
      1_000,
    ) as { id: string };
    const late = 1_000 + LIMITS.ttlMs + 1;
    expect(openAsks(store, late)).toEqual([]);
    expect(askFor(store, id, ME, late)).toMatchObject({ state: "expired" });
    expect(answerAsk(store, id, "yes", late).ok).toBe(false);
  });

  it("a session has at most openPerSession open asks", () => {
    const ask = () =>
      fileAsk(
        store,
        ME,
        { question: "Q", choices: ["yes", "no"] },
        LIMITS,
        1_000,
      );
    expect(ask().ok).toBe(true);
    expect(ask().ok).toBe(true);
    expect(ask()).toMatchObject({ ok: false, code: "ask_limit" });
    // Another session isn't held back by this one's.
    expect(
      fileAsk(
        store,
        { pid: 7, started: "s" },
        { question: "Q", choices: ["yes", "no"] },
        LIMITS,
        1_000,
      ).ok,
    ).toBe(true);
  });

  it("the store survives a reload, and a broken file reads as empty", () => {
    const { id } = fileAsk(
      store,
      ME,
      { question: "Q", choices: ["yes", "no"] },
      LIMITS,
      1_000,
    ) as { id: string };
    const again = new SessionAskStore(path.join(dir, "session-asks.json"));
    expect(askFor(again, id, ME, 1_000)).toMatchObject({ question: "Q" });
    fs.writeFileSync(path.join(dir, "session-asks.json"), "{not json");
    expect(
      openAsks(new SessionAskStore(path.join(dir, "session-asks.json")), 1_000),
    ).toEqual([]);
  });
});

describe("issue 620: Reviewer B's additions", () => {
  const ask = (c: AskCaller, q = "Q") =>
    fileAsk(store, c, { question: q, choices: ["yes", "no"] }, LIMITS, 1_000);

  it("open asks across all sessions are capped too", () => {
    expect(ask({ pid: 1, started: "a" }).ok).toBe(true);
    expect(ask({ pid: 2, started: "b" }).ok).toBe(true);
    expect(ask({ pid: 3, started: "c" }).ok).toBe(true);
    expect(ask({ pid: 4, started: "d" })).toMatchObject({
      ok: false,
      code: "ask_limit_total",
    });
  });

  it("an ask whose process is gone is lost: out of the open list, not answerable", () => {
    const { id } = ask(ME) as { id: string };
    const dead = () => false;
    expect(openAsks(store, 1_000, dead)).toEqual([]);
    expect(askFor(store, id, ME, 1_000)).toMatchObject({ state: "lost" });
    expect(answerAsk(store, id, "yes", 1_000).ok).toBe(false);
  });

  it("the caller's text is stored with secrets masked", () => {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const { id } = fileAsk(
      store,
      ME,
      { question: `Use ${token}?`, choices: ["yes", "no"], session: "s" },
      LIMITS,
      1_000,
    ) as { id: string };
    expect(JSON.stringify(askFor(store, id, ME, 1_000))).not.toContain(token);
    expect(
      fs.readFileSync(path.join(dir, "session-asks.json"), "utf-8"),
    ).not.toContain(token);
  });

  it("keeps what Den found about the caller beside the caller's own label", () => {
    const { id } = fileAsk(
      store,
      { ...ME, command: "node", cwd: "/w/app" },
      { question: "Q", choices: ["yes", "no"], session: "deploy-bot" },
      LIMITS,
      1_000,
    ) as { id: string };
    expect(openAsks(store, 1_000)[0]).toMatchObject({
      id,
      session: "deploy-bot",
      caller: { pid: 4242, command: "node", cwd: "/w/app" },
    });
  });
});
