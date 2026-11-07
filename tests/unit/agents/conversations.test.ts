/**
 * AG-17.1: den-claude lists Claude Code's own conversations for a folder,
 * from a temp CLAUDE_CONFIG_DIR (never this machine's ~/.claude), reading
 * only the two ends of each transcript.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { denClaude } from "../../../src/shared/agents/den-claude.js";
import {
  claudeSlug,
  ENDS_BYTES,
  MAX_CONVERSATIONS,
  openElsewhere,
  readEnds,
} from "../../../src/shared/agents/conversations.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function home(): { dir: string; env: NodeJS.ProcessEnv; work: string } {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-conv-")),
  );
  tmps.push(dir);
  const work = path.join(dir, "work", "north");
  fs.mkdirSync(work, { recursive: true });
  return { dir, env: { CLAUDE_CONFIG_DIR: path.join(dir, "claude") }, work };
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (cwd: string, text: unknown) =>
  line({ type: "user", cwd, message: { role: "user", content: text } });

/** A transcript as Claude Code writes it, under the slug of `cwd`. */
function transcript(
  env: NodeJS.ProcessEnv,
  cwd: string,
  id: string,
  body: string,
  ageMs = 10 * 60_000,
): string {
  const dir = path.join(env.CLAUDE_CONFIG_DIR!, "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, body);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}

const list = (h: ReturnType<typeof home>, folder = h.work) =>
  denClaude.listSessions!(folder, h.env);

describe("den-claude listSessions", () => {
  it("lists a conversation in the folder with its first prompt as the title", () => {
    const h = home();
    transcript(
      h.env,
      h.work,
      "a1b2",
      line({ type: "permission-mode", permissionMode: "default" }) +
        user(h.work, "<command-name>/clear</command-name>") +
        user(h.work, [{ type: "text", text: "Fix the  login\nbug" }]),
    );
    const got = list(h);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: "a1b2",
      title: "Fix the login bug",
      cwd: h.work,
    });
    expect(Number.isFinite(Date.parse(got[0].lastAt))).toBe(true);
  });

  it("a /rename at the end wins, read from the tail of a long transcript", () => {
    const h = home();
    const filler = line({ type: "assistant", text: "x".repeat(1000) }).repeat(
      Math.ceil((ENDS_BYTES * 3) / 1000),
    );
    transcript(
      h.env,
      h.work,
      "c3",
      user(h.work, "first ask") +
        filler +
        line({ type: "custom-title", customTitle: "Payments refactor" }),
    );
    expect(list(h)[0].title).toBe("Payments refactor");
  });

  it("reads only the ends: a cwd only in the middle of a long file is never seen", () => {
    const h = home();
    const filler = line({ type: "assistant", text: "y".repeat(1000) }).repeat(
      Math.ceil((ENDS_BYTES * 2) / 1000),
    );
    transcript(h.env, h.work, "mid", filler + user(h.work, "hi") + filler);
    expect(list(h)).toEqual([]);
    const ends = readEnds(
      path.join(
        h.env.CLAUDE_CONFIG_DIR!,
        "projects",
        claudeSlug(h.work),
        "mid.jsonl",
      ),
    );
    const bytes = [...ends.head, ...ends.tail].join("\n").length;
    expect(bytes).toBeLessThanOrEqual(2 * ENDS_BYTES);
  });

  it("includes a subfolder's conversations, never a sibling whose slug starts the same", () => {
    const h = home();
    const sub = path.join(h.work, "api");
    const sibling = `${h.work}-2`;
    fs.mkdirSync(sub);
    fs.mkdirSync(sibling);
    transcript(h.env, sub, "sub1", user(sub, "in api"));
    transcript(h.env, sibling, "sib1", user(sibling, "next door"));
    expect(list(h).map((c) => c.id)).toEqual(["sub1"]);
  });

  it("newest first, at most MAX_CONVERSATIONS", () => {
    const h = home();
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++)
      transcript(
        h.env,
        h.work,
        `c${i}`,
        user(h.work, `ask ${i}`),
        (i + 1) * 120_000,
      );
    const got = list(h);
    expect(got).toHaveLength(MAX_CONVERSATIONS);
    expect(got[0].id).toBe("c0");
  });

  it("no history, or a folder with none: an empty list, never a throw", () => {
    const h = home();
    expect(list(h)).toEqual([]);
    expect(denClaude.listSessions!("/nowhere/at/all", h.env)).toEqual([]);
  });
});

describe("one writer only", () => {
  it("written in the last 60 s is open elsewhere; older is not", () => {
    const now = Date.now();
    expect(openElsewhere(new Date(now - 5_000).toISOString(), now)).toBe(true);
    expect(openElsewhere(new Date(now - 61_000).toISOString(), now)).toBe(
      false,
    );
  });
});
