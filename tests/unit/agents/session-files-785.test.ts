/**
 * Issue 785: Den reads a runtime's own session files, carefully, to know
 * whether a conversation can resume.
 *
 * - Codex: a reported thread resumes only when its session file's first
 *   line names that thread as a main one (no parent, not a sub-agent's),
 *   in the agent's own folder. A sub-agent's thread never resumes.
 * - Gemini: a session resumes only when its file holds a reply; one that
 *   stopped before its first turn starts fresh.
 *
 * The files are found by listing, never by joining a reported string into
 * a path; links, other owners' files and paths outside the store are
 * refused; only a capped first line (Codex) is parsed; anything unreadable
 * or malformed is "can't resume", never an error.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  codexMainThread,
  geminiResumable,
  sessionStoreOf,
} from "../../../src/shared/agents/session-files.js";

const UID = process.getuid!();
/** The agent was created before its sessions began (09:00 that day). */
const CREATED = "2026-11-22T09:00:00.000Z";
const main = (id: string, cwd: string, home: string, notBefore = CREATED) =>
  codexMainThread(id, {
    store: { env: { CODEX_HOME: home }, uids: [UID] },
    cwd,
    notBefore,
  });

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den785-")));
  tmps.push(d);
  return d;
}

const THREAD = "019a7f2c-1b2d-7e3f-9a8b-0c1d2e3f4a5b";
const CHILD = "019a7f2c-9999-7e3f-9a8b-0c1d2e3f4a5b";

function codexHome(
  meta: Record<string, unknown> | string,
  o: { thread?: string; day?: string } = {},
) {
  const home = tmp();
  const thread = o.thread ?? THREAD;
  const dir = path.join(
    home,
    "sessions",
    ...(o.day ?? "2026/11/22").split("/"),
  );
  fs.mkdirSync(dir, { recursive: true });
  const line =
    typeof meta === "string"
      ? meta
      : JSON.stringify({
          timestamp: "2026-11-22T10:00:00.000Z",
          type: "session_meta",
          payload: {
            session_id: thread,
            id: thread,
            timestamp: "2026-11-22T10:00:00.000Z",
            cwd: "/work/north",
            originator: "codex_cli_rs",
            cli_version: "0.171.0",
            source: "cli",
            ...meta,
          },
        });
  const file = path.join(dir, `rollout-2026-11-22T10-00-00-${thread}.jsonl`);
  fs.writeFileSync(file, `${line}\n{"type":"response_item","payload":{}}\n`);
  return { home, file };
}

describe("issue 785: a Codex thread resumes only as a main thread in its own folder", () => {
  it("a main thread in the agent's folder: yes", async () => {
    const { home } = codexHome({});
    expect(await main(THREAD, "/work/north", home)).toBe(true);
  });

  it("a sub-agent's thread: no (parent, sub-agent source, or a root other than itself)", async () => {
    for (const meta of [
      { parent_thread_id: THREAD, id: CHILD, session_id: THREAD },
      { id: CHILD, session_id: THREAD },
      { id: CHILD, session_id: CHILD, thread_source: "subagent" },
      {
        id: CHILD,
        session_id: CHILD,
        source: { subagent: { thread_spawn: { parent_thread_id: THREAD } } },
      },
    ]) {
      const { home } = codexHome(meta, { thread: CHILD });
      expect(await main(CHILD, "/work/north", home)).toBe(false);
    }
  });

  it("another folder, no file, a file naming another thread, or no store: no", async () => {
    expect(await main(THREAD, "/work/south", codexHome({}).home)).toBe(false);
    expect(await main(CHILD, "/work/north", codexHome({}).home)).toBe(false);
    expect(
      await main(THREAD, "/work/north", codexHome({ id: CHILD }).home),
    ).toBe(false);
    expect(await main(THREAD, "/work/north", path.join(tmp(), "none"))).toBe(
      false,
    );
  });

  it("malformed, or a first line past the cap: no, never a throw", async () => {
    for (const line of ["{not json", "[]", '{"type":"session_meta"}']) {
      const { home } = codexHome(line);
      expect(await main(THREAD, "/work/north", home)).toBe(false);
    }
    const { home } = codexHome({ base_instructions: "x".repeat(1_100_000) });
    expect(await main(THREAD, "/work/north", home)).toBe(false);
  });

  it("a link, as the file or a folder on the way: no", async () => {
    const real = codexHome({});
    const home = tmp();
    fs.mkdirSync(path.join(home, "sessions", "2026", "11"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.dirname(real.file),
      path.join(home, "sessions", "2026", "11", "22"),
    );
    expect(await main(THREAD, "/work/north", home)).toBe(false);
    const home2 = tmp();
    const day = path.join(home2, "sessions", "2026", "11", "22");
    fs.mkdirSync(day, { recursive: true });
    fs.symlinkSync(real.file, path.join(day, path.basename(real.file)));
    expect(await main(THREAD, "/work/north", home2)).toBe(false);
  });

  it("an id that isn't a conversation id is never looked for", async () => {
    const { home } = codexHome({});
    expect(await main("../../etc", "/work/north", home)).toBe(false);
    expect(await main("*", "/work/north", home)).toBe(false);
  });
});

const SESSION = "6f1c2a9e-0b3d-4c5e-8f7a-1b2c3d4e5f60";

function geminiHome(lines: unknown[], o: { name?: string } = {}) {
  const home = tmp();
  const chats = path.join(home, ".gemini", "tmp", "north", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(
    chats,
    o.name ?? `session-2026-11-22T10-00-${SESSION.slice(0, 8)}.jsonl`,
  );
  fs.writeFileSync(
    file,
    lines
      .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
      .join("\n") + "\n",
  );
  return { home, env: { GEMINI_CLI_HOME: home } };
}
const meta = { sessionId: SESSION, projectHash: "h", kind: "main" };

describe("issue 785: a Gemini session resumes only once it holds a reply", () => {
  it("with a reply: yes", () => {
    const { env } = geminiHome([
      meta,
      { id: "m1", type: "user", content: [{ text: "plan it" }] },
      { id: "m2", type: "gemini", content: [{ text: "Planned." }] },
    ]);
    expect(geminiResumable(SESSION, env)).toBe(true);
  });

  it("stopped before its first turn (the startup line only), or a prompt with no reply: no", () => {
    expect(geminiResumable(SESSION, geminiHome([meta]).env)).toBe(false);
    expect(
      geminiResumable(
        SESSION,
        geminiHome([meta, { id: "m1", type: "user", content: "hi" }]).env,
      ),
    ).toBe(false);
    expect(
      geminiResumable(
        SESSION,
        geminiHome([meta, { id: "m2", type: "gemini", content: "" }]).env,
      ),
    ).toBe(false);
  });

  it("another session's file with the same short name, a sub-agent's, or none: no", () => {
    const other = {
      ...meta,
      sessionId: `${SESSION.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`,
    };
    const reply = { id: "m2", type: "gemini", content: "Planned." };
    expect(geminiResumable(SESSION, geminiHome([other, reply]).env)).toBe(
      false,
    );
    expect(
      geminiResumable(
        SESSION,
        geminiHome([{ ...meta, kind: "subagent" }, reply]).env,
      ),
    ).toBe(false);
    expect(geminiResumable(SESSION, { GEMINI_CLI_HOME: tmp() })).toBe(false);
  });

  it("malformed lines are skipped; a link is refused; a bad id is never looked for", () => {
    expect(
      geminiResumable(
        SESSION,
        geminiHome([meta, "{torn", { id: "m2", type: "gemini", content: "ok" }])
          .env,
      ),
    ).toBe(true);
    const real = geminiHome([
      meta,
      { id: "m2", type: "gemini", content: "ok" },
    ]);
    const home = tmp();
    fs.mkdirSync(path.join(home, ".gemini", "tmp"), { recursive: true });
    fs.symlinkSync(
      path.join(real.home, ".gemini", "tmp", "north"),
      path.join(home, ".gemini", "tmp", "north"),
    );
    expect(geminiResumable(SESSION, { GEMINI_CLI_HOME: home })).toBe(false);
    expect(geminiResumable("../x", real.env)).toBe(false);
  });
});

describe("issue 785: only a Codex session the agent began counts (security review)", () => {
  it("a session from before the agent was created (the person's own, same folder): no", async () => {
    const { home } = codexHome({});
    expect(
      await main(THREAD, "/work/north", home, "2026-11-22T11:00:00.000Z"),
    ).toBe(false);
    // A minute of slack for clocks.
    expect(
      await main(THREAD, "/work/north", home, "2026-11-22T10:00:30.000Z"),
    ).toBe(true);
  });

  it("no creation time: no", async () => {
    const { home } = codexHome({});
    expect(
      await codexMainThread(THREAD, {
        store: { env: { CODEX_HOME: home }, uids: [UID] },
        cwd: "/work/north",
        notBefore: undefined,
      }),
    ).toBe(false);
  });

  it("day folders from before the agent's creation are not even listed", async () => {
    const { home } = codexHome({}, { day: "2026/10/01" });
    fs.chmodSync(path.join(home, "sessions", "2026", "10"), 0o000);
    try {
      expect(
        await main(THREAD, "/work/north", home, "2026-10-01T09:00:00.000Z"),
      ).toBe(false);
      expect(await main(THREAD, "/work/north", home)).toBe(false);
    } finally {
      fs.chmodSync(path.join(home, "sessions", "2026", "10"), 0o755);
    }
    expect(
      await main(THREAD, "/work/north", home, "2026-10-01T09:00:00.000Z"),
    ).toBe(true);
  });

  it("a first line past agents.resume_first_line_max_bytes: no; under it: yes", async () => {
    const { home } = codexHome({ base_instructions: "x".repeat(20_000) });
    const check = (firstLineMaxBytes: number) =>
      codexMainThread(THREAD, {
        store: { env: { CODEX_HOME: home }, uids: [UID] },
        cwd: "/work/north",
        notBefore: CREATED,
        firstLineMaxBytes,
      });
    expect(await check(8192)).toBe(false);
    expect(await check(64 * 1024)).toBe(true);
  });
});

describe("issue 785 with 988: the store is the agent's own login's", () => {
  it("runAs from a trusted record: its home and uid; Den's env is not used", () => {
    const store = sessionStoreOf(
      {
        runAs: {
          uid: 4242,
          home: "/opt/den/p/home",
          env: { CODEX_HOME: "/opt/den/p/codex" },
        },
      },
      { HOME: "/home/person", CODEX_HOME: "/home/person/.codex" },
      true,
    );
    expect(store).toEqual({
      env: { HOME: "/opt/den/p/home", CODEX_HOME: "/opt/den/p/codex" },
      uids: [UID, 4242],
    });
  });

  it("runAs from a record an agent could have written, or malformed: none (it starts fresh)", () => {
    const runAs = { uid: 4242, home: "/opt/den/p/home" };
    expect(sessionStoreOf({ runAs }, {}, false)).toBeNull();
    expect(
      sessionStoreOf({ runAs: { ...runAs, home: "rel" } }, {}, true),
    ).toBeNull();
    expect(
      sessionStoreOf(
        { runAs: { ...runAs, env: { CODEX_HOME: "x" } } },
        {},
        true,
      ),
    ).toBeNull();
    expect(sessionStoreOf({}, { HOME: "/h" }, false)).toEqual({
      env: { HOME: "/h" },
      uids: [UID],
    });
  });

  it("a Codex store under the agent's login's home is found from runAs", async () => {
    const { home } = codexHome({});
    const store = sessionStoreOf(
      { runAs: { uid: UID, home: "/nowhere", env: { CODEX_HOME: home } } },
      { HOME: "/home/person" },
      true,
    )!;
    expect(
      await codexMainThread(THREAD, {
        store,
        cwd: "/work/north",
        notBefore: CREATED,
      }),
    ).toBe(true);
  });
});
