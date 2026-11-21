/**
 * Issue 625 follow-up: the held writes gate_box_set and gate_box_remove.
 * Changing the test boxes is a person's (Settings › Server › Test boxes,
 * `gate box add|remove`); an agent asks for it here, and nothing changes
 * until the person Allows it in the browser (gate-routes.ts gateBoxOps).
 * A bad box is refused before anything is asked, in checkBox's words; the
 * web server checks it again at the ask.
 */
import { z } from "zod";
import { BOX_LIMITS, checkBox } from "../../shared/gates/boxes.js";
import { Refusal } from "./guards.js";
import type { DenTool, ToolContext } from "./tools.js";

type Args = Record<string, unknown>;

/** What tools.ts lends: its ask-and-wait, its note and ask args, its HELD words. */
export interface GateBoxToolKit {
  ask: (
    tool: string,
    action: string,
    args: Args,
    own: { note?: unknown; ask?: unknown },
    ctx: ToolContext,
  ) => Promise<unknown>;
  noteArg: z.ZodTypeAny;
  askArg: z.ZodTypeAny;
  held: string;
}

const L = BOX_LIMITS;

/** The box from the tool's args (`slots` is the box's browser_slots). */
function boxOf(a: Args): Args {
  const keys = [
    "name",
    "ssh",
    "ssh_port",
    "ssh_identity",
    "playwright",
    "hold_file",
    "time_scale",
    "playwright_version",
    "min_free_mem_mb",
  ];
  const box: Args = {};
  for (const k of keys) if (a[k] !== undefined) box[k] = a[k];
  if (a.slots !== undefined) box.browser_slots = a.slots;
  // checkBox's order, so the person's card and the ask read the same.
  const c = checkBox(box);
  if (!c.ok) throw new Refusal(`gate_box_set: ${c.error}; nothing was asked.`);
  return c.box as unknown as Args;
}

export function gateBoxTools(k: GateBoxToolKit): DenTool[] {
  return [
    {
      name: "gate_box_set",
      title: "Ask to add or replace a test box",
      description:
        "Issue 625: ask the person to add a test box (another machine whose browsers take gate slots), or replace the one with this name. Same fields as the Test boxes settings and `gate box add`: how Den reaches it (ssh, and/or a playwright ws:// address), slots, and the rest. Den checks the box now and refuses a bad one before anything is asked. Always the person's own Allow: their dialog shows every field; nothing changes until then, and Deny changes nothing. See docs/gate-slots.md." +
        k.held,
      action: true,
      shape: {
        name: z
          .string()
          .describe(
            "The box's name: letters, digits, dot, dash or underscore (box1)",
          ),
        ssh: z
          .string()
          .optional()
          .describe("ssh destination, login@host or host (keys only)"),
        ssh_port: z
          .number()
          .int()
          .min(L.ssh_port.min)
          .max(L.ssh_port.max)
          .optional()
          .describe("ssh port (default 22)"),
        ssh_identity: z
          .string()
          .optional()
          .describe("A key file's path on this machine (never its contents)"),
        playwright: z
          .string()
          .optional()
          .describe("The box's Playwright address, ws:// or wss://"),
        slots: z
          .number()
          .int()
          .min(L.browser_slots.min)
          .max(L.browser_slots.max)
          .optional()
          .describe("Browser runs the box takes at once (default 1)"),
        hold_file: z
          .string()
          .optional()
          .describe(
            "A file on the box that, while present, stops new slots (needs ssh)",
          ),
        time_scale: z
          .number()
          .min(L.time_scale.min)
          .max(L.time_scale.max)
          .optional()
          .describe(
            "Its browsers take this many times as long as this machine's",
          ),
        playwright_version: z
          .string()
          .optional()
          .describe("The Playwright version on the box, like 1.48.0"),
        min_free_mem_mb: z
          .number()
          .int()
          .min(L.min_free_mem_mb.min)
          .max(L.min_free_mem_mb.max)
          .optional()
          .describe("No slot while the box has less free memory (MB)"),
        note: k.noteArg,
        ask: k.askArg,
      },
      async run(a, ctx) {
        const box = boxOf(a);
        return k.ask("gate_box_set", "gate_box_set", { box }, a, ctx);
      },
    },
    {
      name: "gate_box_remove",
      title: "Ask to remove a test box",
      description:
        "Issue 625: ask the person to remove a test box by name. Runs on it now finish; no new run goes there. Refused when there is no box of that name. Always the person's own Allow; Deny changes nothing." +
        k.held,
      action: true,
      shape: {
        name: z.string().describe("The box's name"),
        note: k.noteArg,
        ask: k.askArg,
      },
      async run(a, ctx) {
        const name = typeof a.name === "string" ? a.name.trim() : "";
        if (!name)
          throw new Refusal(
            "gate_box_remove: give name (the test box's name); nothing was asked.",
          );
        return k.ask("gate_box_remove", "gate_box_remove", { name }, a, ctx);
      },
    },
  ];
}
