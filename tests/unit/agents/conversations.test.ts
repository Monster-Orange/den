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
  inScope,
  openElsewhere,
  readEnds,
  resetTurnCache,
  transcriptBusy,
} from "../../../src/shared/agents/conversations.js";
import { conversationFolders } from "../../../src/shared/environment-manager/workspaces.js";

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

describe("a shared repos root (AG-17.1, dogfood on 0.4.14)", () => {
  /** Three workspaces on one root, one repo each, plus a folder no repo is. */
  function shared() {
    const h = home();
    const root = path.join(h.dir, "repos");
    const repo = (n: string) => {
      const d = path.join(root, n);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    const ws = (r: string) =>
      conversationFolders(
        `no-such-ws-${path.basename(r)}`,
        {
          services: { [path.basename(r)]: { mode: "dev-managed", path: r } },
        } as never,
        root,
      );
    const [a, b, c] = ["alpha", "beta", "gamma"].map(repo);
    const loose = repo("notes");
    let n = 0;
    for (const cwd of [a, b, c, loose, root])
      transcript(
        h.env,
        cwd,
        `id-${path.basename(cwd)}`,
        user(cwd, "hello"),
        ++n * 60_000,
      );
    return { h, root, a, b, c, ws };
  }
  const ids = (
    h: ReturnType<typeof home>,
    scope: { under: string[]; exact?: string[] },
  ) =>
    denClaude.listSessions!(scope, h.env)
      .map((x) => x.id)
      .sort();

  it("each workspace lists only its own repo's, and the root's own, never another's or a loose folder's", () => {
    const { h, a, b, c, ws } = shared();
    expect(ids(h, ws(a))).toEqual(["id-alpha", "id-repos"]);
    expect(ids(h, ws(b))).toEqual(["id-beta", "id-repos"]);
    expect(ids(h, ws(c))).toEqual(["id-gamma", "id-repos"]);
  });

  it("the cap applies after the filter: others' newer conversations never crowd one out", () => {
    const { h, root, a, ws } = shared();
    const other = path.join(root, "beta");
    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++)
      transcript(h.env, other, `crowd-${i}`, user(other, "x"), 1_000 + i);
    expect(ids(h, ws(a))).toContain("id-alpha");
  });

  it("a workspace with its own folder keeps everything in it", () => {
    const h = home();
    const sub = path.join(h.work, "docs");
    fs.mkdirSync(sub);
    transcript(h.env, sub, "id-docs", user(sub, "x"));
    expect(ids(h, { under: [h.work] })).toEqual(["id-docs"]);
  });

  it("inScope agrees with the list", () => {
    const { root, a, b, ws } = shared();
    expect(inScope(a, ws(a))).toBe(true);
    expect(inScope(root, ws(a))).toBe(true);
    expect(inScope(b, ws(a))).toBe(false);
    expect(inScope(path.join(root, "notes"), ws(a))).toBe(false);
  });
});

/** An assistant record: its model, stop reason and tool calls. */
const answer = (
  model: string,
  stop: string | null,
  tools: string[] = [],
  text = "Done.",
) =>
  line({
    type: "assistant",
    message: {
      role: "assistant",
      model,
      stop_reason: stop,
      content: [
        { type: "text", text },
        ...tools.map((name) => ({ type: "tool_use", id: name, name })),
      ],
    },
  });

describe("AG-17.1c: what a conversation ran with", () => {
  it("its last answer's model, and the MCP servers its tools came from", () => {
    const h = home();
    transcript(
      h.env,
      h.work,
      "m1",
      user(h.work, "Plan it") +
        answer("claude-sonnet-4-5", "tool_use", [
          "mcp__linear__get_issue",
          "Read",
        ]) +
        answer("claude-opus-4-5", "end_turn", ["mcp__acme__run_tests"]) +
        answer("<synthetic>", "end_turn"),
    );
    const [c] = list(h);
    expect(c.model).toBe("claude-opus-4-5");
    expect(c.mcp).toEqual(["acme", "linear"]);
  });

  it("no answers: no model, no servers", () => {
    const h = home();
    transcript(h.env, h.work, "m2", user(h.work, "Hello"));
    const [c] = list(h);
    expect(c.model).toBeUndefined();
    expect(c.mcp).toBeUndefined();
  });
});

describe("AG-18: whether a turn is going (transcriptBusy)", () => {
  const busy = (body: string, ageMs = 60_000) => {
    const h = home();
    return transcriptBusy(transcript(h.env, h.work, "b1", body, ageMs));
  };
  const w = "/w";
  it("an ended answer is idle; a tool call or an unanswered prompt is busy", () => {
    expect(busy(user(w, "go") + answer("m", "end_turn"))).toBe(false);
    expect(busy(user(w, "go") + answer("m", "tool_use", ["Bash"]))).toBe(true);
    expect(busy(answer("m", "end_turn") + user(w, "and now?"))).toBe(true);
    // A tool's result came back: the model is answering.
    expect(
      busy(
        answer("m", "tool_use", ["Bash"]) +
          user(w, [{ type: "tool_result", content: "ok" }]),
      ),
    ).toBe(true);
  });

  it("no stop reason: busy until the file is quiet; interrupted is idle; none is idle", () => {
    expect(busy(answer("m", null), 1_000)).toBe(true);
    expect(busy(answer("m", null), 60_000)).toBe(false);
    expect(
      busy(
        answer("m", "tool_use", ["Bash"]) +
          user(w, [{ type: "text", text: "[Request interrupted by user]" }]),
      ),
    ).toBe(false);
    expect(transcriptBusy(null)).toBe(false);
  });

  describe("D39: records that start no turn", () => {
    const summary = (text: string) =>
      line({
        type: "user",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: "user", content: text },
      });
    const ended = user(w, "go") + answer("m", "end_turn");

    it("an agent idle after compacting is idle, however the summary starts", () => {
      expect(
        busy(ended + summary("This session is being continued from …")),
      ).toBe(false);
      expect(busy(ended + summary("<earlier-context/>\nThis session …"))).toBe(
        false,
      );
      // Only the flag that hides it from the model: still no turn.
      expect(
        busy(
          ended +
            line({
              type: "user",
              isVisibleInTranscriptOnly: true,
              message: { role: "user", content: "a note" },
            }),
        ),
      ).toBe(false);
    });

    it("the summary's attachments run past the end it reads: it reads further back, never the start", () => {
      // As Claude Code writes it: the summary, then files, listings and
      // notes as attachments, often more than the end Den reads.
      const attachments = Array.from({ length: 12 }, (_, i) =>
        line({
          type: "attachment",
          attachment: { type: "file", content: "x".repeat(100), n: i },
          message: "user",
        }),
      ).join("");
      const h = home();
      const file = transcript(
        h.env,
        h.work,
        "b39",
        user(w, "the first ask") +
          "y".repeat(400) +
          "\n" +
          answer("m", "tool_use", ["Bash"]) +
          answer("m", "end_turn") +
          summary("This session is being continued") +
          attachments,
      );
      expect(transcriptBusy(file, Date.now(), 300)).toBe(false);
      // Without the summary's flag it would be a prompt: busy, read as far.
      const g = home();
      const plain = transcript(
        g.env,
        g.work,
        "b40",
        answer("m", "end_turn") + user(w, "and now?") + attachments,
      );
      expect(transcriptBusy(plain, Date.now(), 300)).toBe(true);
    });

    it("reads back at most its limit: past it, can't tell (null), never busy or idle", () => {
      const filler = Array.from({ length: 40 }, (_, i) =>
        line({ type: "attachment", attachment: { n: i, x: "z".repeat(100) } }),
      ).join("");
      const h = home();
      const file = transcript(
        h.env,
        h.work,
        "b41",
        answer("m", "end_turn") + filler,
      );
      expect(transcriptBusy(file, Date.now(), 300, 1_000)).toBeNull();
      expect(transcriptBusy(file, Date.now(), 300, 100_000)).toBe(false);
      // den-claude passes agents.turn_read_max_mb through.
      expect(denClaude.turnBusy!("b41", h.env, { readMaxBytes: 1_000 })).toBe(
        null,
      );
      expect(denClaude.turnBusy!("b41", h.env)).toBe(false);
    });

    it("keeps a verdict while the file's size and mtime stay the same", () => {
      resetTurnCache();
      const h = home();
      const a = answer("m", "end_turn");
      const file = transcript(h.env, h.work, "b42", user(w, "go") + a);
      expect(transcriptBusy(file)).toBe(false);
      // Same length, same mtime: the kept verdict, the file not read.
      const st = fs.statSync(file);
      const same = (user(w, "go") + a).replace("end_turn", "tool_use");
      expect(same.length).toBe(st.size);
      fs.writeFileSync(file, same);
      fs.utimesSync(file, st.atime, st.mtime);
      expect(transcriptBusy(file)).toBe(false);
      // A new mtime: read again.
      fs.utimesSync(file, st.atime, new Date(st.mtimeMs + 2_000));
      expect(transcriptBusy(file)).toBe(true);
    });

    it("compacting mid-turn stays busy, and a prompt after the summary is busy", () => {
      expect(
        busy(
          answer("m", "tool_use", ["Bash"]) +
            user(w, [{ type: "tool_result", content: "ok" }]) +
            summary("This session is being continued …"),
        ),
      ).toBe(true);
      expect(busy(ended + summary("…") + user(w, "and now?"))).toBe(true);
    });

    it("a person's ! command and a local command's output are no turn", () => {
      expect(
        busy(
          ended +
            user(w, "<bash-input>ls</bash-input>") +
            user(
              w,
              "<bash-stdout>a b</bash-stdout><bash-stderr></bash-stderr>",
            ),
        ),
      ).toBe(false);
      expect(
        busy(
          ended +
            user(w, "<command-name>/cost</command-name>") +
            user(w, "<local-command-stdout>$0.12</local-command-stdout>"),
        ),
      ).toBe(false);
      // A command the model answers (a skill) is a turn until it does.
      expect(
        busy(
          ended +
            user(w, "<command-name>/review</command-name>") +
            line({
              type: "user",
              isMeta: true,
              message: { role: "user", content: "Review the diff." },
            }),
        ),
      ).toBe(true);
    });

    it("a summary is never a conversation's title", () => {
      const h = home();
      transcript(
        h.env,
        h.work,
        "c39",
        summary("This session is being continued") + user(h.work, "Real ask"),
      );
      expect(list(h)[0].title).toBe("Real ask");
    });
  });

  it("den-claude asks it by the conversation's id", () => {
    const h = home();
    transcript(h.env, h.work, "b2", answer("m", "tool_use", ["Bash"]));
    expect(denClaude.turnBusy!("b2", h.env)).toBe(true);
    // No transcript Den can read (another config folder, or none yet):
    // it can't tell, so nothing waiting on the turn's end goes ahead.
    expect(denClaude.turnBusy!("nope", h.env)).toBeNull();
    expect(
      denClaude.turnBusy!("b2", {
        ...h.env,
        CLAUDE_CONFIG_DIR: "/nonexistent-den-test",
      }),
    ).toBeNull();
  });
});
