/**
 * Issue 1395: gate_settings_set, the held write an agent uses to ask for
 * a change to this machine's gate slot settings (the gates folder's
 * settings.json, which setting_change can't reach: it writes user.yml).
 *
 * The keys and ranges are Settings › Gate's (checkGatePatch). The card
 * shows each key's value in effect now and the one asked for. Each key is
 * named gate.<key> for the approval policy, where gate keys are Limits
 * and performance (issue 1391), scheduling on the person's own machine:
 * on a personal install the change is written at once and the person is
 * told; on a strict one it follows the person's choice for Limits. A
 * change that widens what agents may do (issue 1264: routing off, or a
 * program dropped from it) needs the person's own Allow on both. On
 * Allow it's checked again and written by the gate's one writer,
 * GateStore.writeSettings, under the gate-slot lock; a refused value
 * writes nothing.
 */
import {
  settingChoice,
  type PolicySetting,
  type SettingCategory,
} from "../approval-policy.js";
import type { InstallMode } from "../den-config.js";
import { line, reviewLines, type DetailKey } from "../review-lines.js";
import { plainText } from "../agents/sandbox-set.js";
import {
  checkGatePatch,
  gateSettingValue,
  type GateSettingsPatch,
} from "./store.js";
import type { GateSettings } from "./rules.js";

export const GATE_SETTINGS_SET_ACTION = "gate_settings_set";
/** The longest reason an ask may give (one line). */
export const GATE_REASON_MAX = 300;

export interface GateSettingsSetArgs {
  settings: GateSettingsPatch;
  reason: string;
  /**
   * Each changing key's value in effect at the ask (the card's "now").
   * Kept in the held write's args: on Allow a key that moved since is
   * refused, so what runs is what the person saw and was judged.
   */
  seen: Record<string, number | string | null>;
}

export interface GateSettingsSetDeps {
  /** The settings in effect now, or (with a patch) as they'd be after it. */
  settings: (patch?: GateSettingsPatch) => GateSettings;
  /** The one writer: GateStore.writeSettings under the gate-slot lock. */
  write: (patch: GateSettingsPatch, by: string) => Promise<void>;
  /** The install's mode (issue 1391). */
  installMode: () => InstallMode;
  /** A dotted key's kind for the policy (setting-change.ts settingKind). */
  kind: (
    key: string,
    value: number | string | null,
    /** The value in effect now. */
    before: number | string | null,
  ) => { category: SettingCategory; widens: boolean };
  /** The person's per-category choices (approvals.settings). */
  choices: () => PolicySetting["settings"];
}

export type GateSettingsSetCheck =
  | {
      ok: true;
      personOnly?: boolean;
      category: SettingCategory;
      summary: string;
      params: Record<string, string>;
      details: string[];
      detailKeys: DetailKey[];
      args: GateSettingsSetArgs;
    }
  | {
      ok: false;
      error: string;
      /** Every value asked for is already in effect. */
      inEffect?: true;
    };

const shown = (v: number | string | null) =>
  v === null || v === "" ? "unset" : String(v);

export function checkGateSettingsSet(
  d: GateSettingsSetDeps,
  raw: Record<string, unknown>,
): GateSettingsSetCheck {
  const no = (error: string): GateSettingsSetCheck => ({ ok: false, error });
  try {
    const reason = typeof raw.reason === "string" ? plainText(raw.reason) : "";
    if (!reason)
      return no(
        "reason is required: say why the gate's settings should change",
      );
    if (reason.length > GATE_REASON_MAX)
      return no(
        `reason must be ${GATE_REASON_MAX} characters or fewer (got ${reason.length})`,
      );
    // Each key as Settings › Gate names it, or as gate.<key>.
    const asked =
      raw.settings &&
      typeof raw.settings === "object" &&
      !Array.isArray(raw.settings)
        ? Object.fromEntries(
            Object.entries(raw.settings as Record<string, unknown>).map(
              ([k, v]) => [k.startsWith("gate.") ? k.slice(5) : k, v],
            ),
          )
        : raw.settings;
    const c = checkGatePatch(asked);
    if (!c.ok) return no(c.error.replace(/^gate_slots/, "settings"));
    if (!Object.values(c.patch).some((v) => v !== undefined))
      return no("settings is empty: name at least one key and its value");
    // The values the card showed, when this is the check on Allow.
    const seenRaw = raw.seen;
    if (
      seenRaw !== undefined &&
      (!seenRaw || typeof seenRaw !== "object" || Array.isArray(seenRaw))
    )
      return no("seen is the values in effect at the ask, by key");
    const seen = seenRaw as Record<string, unknown> | undefined;
    const now = d.settings();
    // Each value as it'd be in effect after the change (a cleared key's
    // default included, which may differ by platform).
    const after = d.settings(c.patch);
    const patch: GateSettingsPatch = {};
    const changes: {
      key: string;
      from: string;
      to: string;
      value: number | string | null;
      before: number | string | null;
    }[] = [];
    for (const [k, v] of Object.entries(c.patch)) {
      if (v === undefined) continue;
      const from = gateSettingValue(now, k);
      const to = gateSettingValue(after, k);
      if (from === to) continue;
      if (seen && Object.hasOwn(seen, k) && seen[k] !== from)
        return no(
          `gate.${k} changed since the ask (it was ${shown(seen[k] as number | string | null)}, it's ${shown(from)} now): nothing was written; ask again, so the person sees it`,
        );
      (patch as Record<string, unknown>)[k] = v;
      changes.push({
        key: `gate.${k}`,
        from: shown(from),
        to: v === null ? `default (${shown(to)})` : shown(to),
        value: to,
        before: from,
      });
    }
    if (!changes.length)
      return {
        ok: false,
        error: "nothing to change: each value asked for is the one in effect",
        inEffect: true,
      };
    const kinds = changes.map((x) => d.kind(x.key, x.value, x.before));
    const widens = kinds.some((k) => k.widens);
    const category = kinds[0]!.category;
    const choice = settingChoice(category, d.installMode(), d.choices());
    if (choice.choice === "never")
      return no(
        `gate settings aren't changed by agents here (approvals.settings.${category} is never): a person changes them in Settings › Gate`,
      );
    const r = reviewLines([
      ...changes.map((x) =>
        line(
          `${x.key}: ${x.from} → ${x.to}`,
          "ap.det.gate_settings_set.change",
          {
            key: x.key,
            from: x.from,
            to: x.to,
          },
        ),
      ),
      line(`Why: ${reason}`, "ap.det.gate_settings_set.why", { why: reason }),
      line(
        "Den writes these in the gates folder's settings.json, under the gate's lock, and nothing else there.",
        "ap.det.gate_settings_set.writes",
      ),
    ]);
    return {
      ok: true,
      ...(widens ? { personOnly: true } : {}),
      category,
      summary: changes.map((x) => `${x.key}: ${x.from} → ${x.to}`).join(", "),
      params: {
        keys: changes.map((x) => x.key).join(", "),
        ...(widens ? { loosens: "1" } : {}),
      },
      details: r.details,
      detailKeys: r.detailKeys,
      args: {
        settings: patch,
        reason,
        seen: Object.fromEntries(
          Object.keys(patch).map((k) => [k, gateSettingValue(now, k)]),
        ),
      },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/** On Allow (or at once, by the policy): checked again, then written. */
export async function runGateSettingsSet(
  d: GateSettingsSetDeps,
  raw: Record<string, unknown>,
  asked?: { agent?: string; decidedBy?: string },
): Promise<
  { ok: true; changed: string[]; note?: string } | { ok: false; error: string }
> {
  const c = checkGateSettingsSet(d, raw);
  // An Allow that finds it all in place already (set by hand since the
  // ask) is done: nothing to write, and no error.
  if (!c.ok && c.inEffect)
    return { ok: true, changed: [], note: "already in effect" };
  if (!c.ok) return { ok: false, error: c.error };
  // Builder 2 (as issue 1404's den_update and host_restart): run by the
  // policy at once, and it now widens what agents may do: it needs the
  // person's own Allow, so nothing is written.
  if (c.personOnly && asked?.decidedBy?.startsWith("auto:") === true)
    return {
      ok: false,
      error:
        "this change now widens what agents may do, so it needs the person's own Allow: nothing was written; ask again",
    };
  try {
    await d.write(
      c.args.settings,
      asked?.agent ?? "a person (gate_settings_set)",
    );
  } catch (e) {
    return { ok: false, error: `nothing was changed: ${(e as Error).message}` };
  }
  return {
    ok: true,
    changed: Object.keys(c.args.settings).map((k) => `gate.${k}`),
  };
}
