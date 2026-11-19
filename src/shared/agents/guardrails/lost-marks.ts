/**
 * Issue 609: an attention mark Den never took leaves a trace. The
 * attention hook, when its call fails, appends one line to the agent's
 * own files dir (agent-hooks-lost.jsonl): when, the agent, the event, and why
 * (no answer, or Den's refusal and its status). `doctor` shows a row per
 * agent with marks lost in the last day: how many, and the last reason.
 *
 * Kept small (fs only): the hook loads it on every event.
 */
import * as fs from "fs";
import * as path from "path";

/** The file, in each agent's files dir (<state>/agent-files/<id>). */
export const LOST_FILE = "agent-hooks-lost.jsonl";

/** Every agent's file under Den's state dir (those that exist). */
export function lostFiles(stateDir: string): string[] {
  const dir = path.join(stateDir, "agent-files");
  let ids: string[];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return ids
    .map((id) => path.join(dir, id, LOST_FILE))
    .filter((f) => fs.existsSync(f));
}
/** Over this, the file starts again (the old one kept as .1). */
const MAX_BYTES = 512 * 1024;
/** doctor counts marks lost in this window. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LostMark {
  agent: string;
  event: string;
  reason: string;
  at?: Date;
}

/** Append one lost mark. Never throws: a hook fails open. */
export function recordLost(file: string, m: LostMark): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* not there yet */
    }
    const line = JSON.stringify({
      ts: (m.at ?? new Date()).toISOString(),
      agent: m.agent.slice(0, 200),
      event: m.event.slice(0, 40),
      reason: m.reason.slice(0, 200),
    });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* fails open */
  }
}

type Lang = "en" | "es" | "ja";
type Word = "head" | "one" | "many";

/** doctor's words, in each language the UI ships (a test keeps them even). */
export const LOST_WORDS: Readonly<
  Record<Lang, Readonly<Record<Word, string>>>
> = {
  en: {
    head: "{title} doctor: Agent attention marks",
    one: "{agent}: 1 attention mark lost in the last day; the last: {reason}",
    many: "{agent}: {count} attention marks lost in the last day; the last: {reason}",
  },
  es: {
    head: "{title} doctor: avisos de atención de los agentes",
    one: "{agent}: 1 aviso de atención perdido en el último día; el último: {reason}",
    many: "{agent}: {count} avisos de atención perdidos en el último día; el último: {reason}",
  },
  ja: {
    head: "{title} doctor: エージェントの注意の通知",
    one: "{agent}: 過去 1 日に注意の通知が 1 件失われました。最後の理由: {reason}",
    many: "{agent}: 過去 1 日に注意の通知が {count} 件失われました。最後の理由: {reason}",
  },
};

const say = (lang: Lang, k: Word, vars: Record<string, string | number>) =>
  (LOST_WORDS[lang] ?? LOST_WORDS.en)[k].replace(/\{(\w+)\}/g, (m, v) =>
    v in vars ? String(vars[v]) : m,
  );

/**
 * doctor's lines and checks: one warning per agent with marks lost in the
 * last day. Nothing lost: none.
 */
export function lostMarkLines(
  files: string | string[],
  o: { now?: Date; lang?: Lang; title: string },
): {
  lines: string[];
  checks: { id: string; status: "warn"; detail: string }[];
} {
  let text = "";
  for (const f of Array.isArray(files) ? files : [files])
    try {
      text += `${fs.readFileSync(f, "utf8")}\n`;
    } catch {
      /* none */
    }
  const since = (o.now ?? new Date()).getTime() - WINDOW_MS;
  const by = new Map<string, { count: number; last: string; at: number }>();
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    let r: { ts?: unknown; agent?: unknown; reason?: unknown };
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    const at = Date.parse(String(r.ts));
    if (!(at >= since) || typeof r.agent !== "string") continue;
    const b = by.get(r.agent) ?? { count: 0, last: "", at: 0 };
    b.count++;
    if (at >= b.at) {
      b.at = at;
      b.last = String(r.reason ?? "");
    }
    by.set(r.agent, b);
  }
  if (!by.size) return { lines: [], checks: [] };
  const lang = o.lang ?? "en";
  const checks = [...by.keys()].sort().map((agent) => {
    const b = by.get(agent)!;
    return {
      id: `attention_lost:${agent}`,
      status: "warn" as const,
      detail: say(lang, b.count === 1 ? "one" : "many", {
        agent,
        count: b.count,
        reason: b.last,
      }),
    };
  });
  return {
    lines: [
      "",
      say(lang, "head", { title: o.title }),
      "",
      ...checks.map((c) => `  ⚠  ${c.detail}`),
    ],
    checks,
  };
}
