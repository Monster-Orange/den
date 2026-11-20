/**
 * Issue 609 (the 0.4.77-dev.3 bed): a permission wait's own tool run
 * clears it, however soon it comes and whatever the order the two calls
 * are applied in. The bed saw a PostToolUse 0.5 s after its
 * PermissionRequest dropped as "a tool run beside it" (RESUME_AFTER_MS),
 * so each mark stayed until the check gave up on it. A tool run that
 * isn't the one asked about still doesn't clear it that soon.
 * No sleeps: a held output mark stands in for a slow set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention, RESUME_AFTER_MS } from "../../../src/ui/server/attention";
import { attentionOf } from "../../../src/shared/agents/guardrails/attention-hook";

let dir = "";
let clock = 1_000_000;

function mk(
  outputMark: (id: string) => Promise<string | null> = async () => null,
) {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark,
    nameOf: (id) => id,
    now: () => clock,
    hooked: () => true,
  });
  return { store, a };
}

/** The server's view of a hook's event (attention-hook.ts → the route). */
function hookEv(input: Record<string, unknown>) {
  const ev = attentionOf(input);
  if (!ev) throw new Error("no event");
  return ev as Parameters<Attention["event"]>[2];
}

const ask = (tool: string, input: unknown = { command: "echo x" }) =>
  hookEv({
    hook_event_name: "PermissionRequest",
    tool_name: tool,
    tool_input: input,
  });
const ran = (tool: string, input?: unknown) =>
  hookEv({
    hook_event_name: "PostToolUse",
    tool_name: tool,
    ...(input === undefined ? {} : { tool_input: input }),
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-att609-"));
  clock = 1_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 609: a wait's own tool run clears it", () => {
  it("the hooks name the tool use: PostToolUse says which tool ran, both say which input", () => {
    const p = ask("Bash", { command: "ls" }) as {
      what?: string;
      input?: string;
    };
    const r = ran("Bash", { command: "ls" }) as {
      what?: string;
      input?: string;
    };
    expect(r.what).toBe("Bash");
    expect(p.input).toMatch(/^[0-9a-f]{16}$/);
    expect(r.input).toBe(p.input);
    // The input travels as a hash, never as the command.
    expect(JSON.stringify(p)).not.toContain("ls");
    expect(
      (ran("Bash", { command: "pwd" }) as { input?: string }).input,
    ).not.toBe(p.input);
  });

  it("its tool's run 0.5 s after the dialog clears it (the bed's dev.3 run)", async () => {
    const { store, a } = mk();
    await a.event("ag", "web", ask("Gate609Tool0"));
    expect(a.waitingDetail("ag")?.what).toBe("Gate609Tool0");
    clock += 500;
    await a.event("ag", "web", ran("Gate609Tool0"));
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
    // The next tool's dialog shows as its own wait.
    clock += 500;
    await a.event("ag", "web", ask("Gate609Tool1"));
    expect(a.waitingDetail("ag")?.what).toBe("Gate609Tool1");
  });

  it("the same input clears it at once; another run of that tool beside it doesn't", async () => {
    const { a } = mk();
    await a.event("ag", "web", ask("Bash", { command: "rm x" }));
    clock += 200;
    await a.event("ag", "web", ran("Bash", { command: "ls" }));
    expect(a.waitingNow().size).toBe(1);
    await a.event("ag", "web", ran("Read", { file_path: "/a" }));
    expect(a.waitingNow().size).toBe(1);
    await a.event("ag", "web", ran("Bash", { command: "rm x" }));
    expect(a.waitingNow().size).toBe(0);
  });

  it("an unnamed tool run that soon still doesn't clear it (hooks from before)", async () => {
    const { a } = mk();
    await a.event("ag", "web", ask("Bash"));
    clock += RESUME_AFTER_MS - 1;
    await a.event("ag", "web", { event: "resumed", from: "tool" });
    expect(a.waitingNow().size).toBe(1);
  });

  it("the run lands while the dialog's mark is still being set: the clear wins", async () => {
    let release: (v: string | null) => void = () => {};
    let held = true;
    const { store, a } = mk(() =>
      held
        ? new Promise<string | null>((r) => {
            release = r;
          })
        : Promise.resolve(null),
    );
    const setting = a.event("ag", "web", ask("Gate609Tool0"));
    clock += 500;
    held = false;
    await a.event("ag", "web", ran("Gate609Tool0"));
    release("m1");
    await setting;
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("the run applied before its dialog (the calls swapped): no wait is left", async () => {
    const { store, a } = mk();
    await a.event("ag", "web", ran("Gate609Tool0", { command: "echo x" }));
    clock += 100;
    await a.event("ag", "web", ask("Gate609Tool0"));
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
    // A later dialog for the same tool and input is a new one.
    clock += RESUME_AFTER_MS + 1;
    await a.event("ag", "web", ask("Gate609Tool0"));
    expect(a.waitingNow().size).toBe(1);
  });
});
