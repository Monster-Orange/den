/**
 * Personas (AG-2a, AG spec §4): who an agent is. A persona is a markdown
 * file whose YAML front matter says what it is and whose body is its role
 * prompt. A persona-pack is a directory of them.
 *
 * The format is Claude Code's agent file, read as it is, so a pack can
 * point at a Claude Code plugin's agents/ directory without converting or
 * forking it:
 *
 *   name         the id (Den's `id` wins when both are given)
 *   description  the one-line role (Den's `role` wins)
 *   model        the default model; `inherit` means none of its own
 *   tools        "Read, Grep" or a list: hints, never a restriction Den applies
 *
 * Den's own keys sit beside them: `runtime` (default den-claude),
 * `standing` (starts with its workspace, §5), `context` (what to read
 * first), and `argv` (the generic runtime's template). Any other key (a
 * Claude Code `color`) is ignored. A file without front matter (a pack's
 * README) is not a persona.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { WORKSPACE_NAME_RE } from "../agent-actor.js";
import { enginePath } from "../engine.js";

export interface Persona {
  id: string;
  /** One line: what it does. */
  role: string;
  /** The role prompt: the file's body. */
  prompt: string;
  /** The runtime it runs on unless an agent says otherwise. */
  runtime?: string;
  /** The model it runs unless an agent says otherwise. */
  model?: string;
  /** Started with its workspace (planner, orchestrator). */
  standing: boolean;
  /** Tool hints. */
  tools: string[];
  /** What to read first (specs, the design system, workspace config). */
  context: string[];
  /** The generic runtime's argv template ({model}, {mcp_config}). */
  argv?: string[];
  /** The file it came from. */
  source: string;
}

/** A persona id: the same rules as an agent id or a workspace name. */
export const PERSONA_ID_RE = WORKSPACE_NAME_RE;

/** Den's own pack, shipped in the package (src/ ships whole). */
export const DEFAULT_PACK_DIR = enginePath(
  "src",
  "shared",
  "agents",
  "default-pack",
);

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function optString(
  fm: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const v = fm[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" && typeof v !== "number")
    throw new Error(`${where}: ${key} must be a string`);
  const s = String(v).trim();
  return s || undefined;
}

/** `tools: Read, Grep` (Claude Code) or `tools: [read, grep]`. */
function stringList(
  fm: Record<string, unknown>,
  key: string,
  where: string,
): string[] {
  const v = fm[key];
  if (v === undefined || v === null) return [];
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string"))
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  throw new Error(`${where}: ${key} must be a list of strings`);
}

/** One persona file, or null when it has no front matter. */
export function parsePersona(text: string, file: string): Persona | null {
  const m = FRONT_MATTER.exec(text);
  if (!m) return null;
  let fm: unknown;
  try {
    fm = yaml.parse(m[1]);
  } catch (e) {
    throw new Error(
      `${file}: front matter is not YAML (${(e as Error).message.split("\n")[0]})`,
    );
  }
  if (fm === null || fm === undefined) fm = {};
  if (typeof fm !== "object" || Array.isArray(fm))
    throw new Error(`${file}: front matter must be a mapping`);
  const f = fm as Record<string, unknown>;
  const id =
    optString(f, "id", file) ??
    optString(f, "name", file) ??
    path.basename(file, path.extname(file));
  if (!PERSONA_ID_RE.test(id))
    throw new Error(
      `${file}: id "${id}" must be letters, digits, ".", "_" or "-", 1-64 long, starting with a letter or digit`,
    );
  const standing = f.standing ?? false;
  if (typeof standing !== "boolean")
    throw new Error(`${file}: standing must be true or false`);
  let argv: string[] | undefined;
  if (f.argv !== undefined && f.argv !== null) {
    if (
      !Array.isArray(f.argv) ||
      !f.argv.length ||
      !f.argv.every((a) => typeof a === "string")
    )
      throw new Error(`${file}: argv must be a list of strings`);
    argv = f.argv as string[];
  }
  const model = optString(f, "model", file);
  const runtime = optString(f, "runtime", file);
  return {
    id,
    role: optString(f, "role", file) ?? optString(f, "description", file) ?? "",
    prompt: text.slice(m[0].length).trim(),
    ...(runtime ? { runtime } : {}),
    ...(model && model !== "inherit" ? { model } : {}),
    standing,
    tools: stringList(f, "tools", file),
    context: stringList(f, "context", file),
    ...(argv ? { argv } : {}),
    source: file,
  };
}

/**
 * A pack's personas, by file name. A directory with an `agents/` inside (a
 * Claude Code plugin) is read from there.
 */
export function readPack(dir: string): Persona[] {
  const agents = path.join(dir, "agents");
  const from = fs.statSync(agents, { throwIfNoEntry: false })?.isDirectory()
    ? agents
    : dir;
  const out: Persona[] = [];
  const seen = new Map<string, string>();
  for (const name of fs.readdirSync(from).sort()) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(from, name);
    if (!fs.statSync(file).isFile()) continue;
    const p = parsePersona(fs.readFileSync(file, "utf-8"), file);
    if (!p) continue;
    const prev = seen.get(p.id);
    if (prev) throw new Error(`${prev} and ${file} both define "${p.id}"`);
    seen.set(p.id, file);
    out.push(p);
  }
  return out;
}

/** `agents.persona_packs`, absolute; each must be a directory. */
export function resolvePackDirs(packs: string[], distRoot: string): string[] {
  return packs.map((p, i) => {
    const abs = path.resolve(distRoot, p);
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`agents.persona_packs[${i}]: ${abs} is not a directory`);
    return abs;
  });
}

/**
 * Every persona: Den's default pack, then each pack in order. A later
 * pack's persona replaces an earlier one of the same id.
 */
export function loadPersonas(
  packDirs: string[],
  defaultPack: string = DEFAULT_PACK_DIR,
): Map<string, Persona> {
  const all = new Map<string, Persona>();
  for (const dir of [defaultPack, ...packDirs])
    for (const p of readPack(dir)) all.set(p.id, p);
  return all;
}

/**
 * The role prompt as an agent gets it: who and where it is, what to read
 * first, then the persona's own prompt. Runtime-neutral; a runtime only
 * chooses how to pass it in.
 */
export function rolePrompt(
  persona: Persona,
  agentId: string,
  workspace: string,
  mcpName: string,
): string {
  const lines = [
    `You are agent ${agentId} in workspace ${workspace}, with the ${persona.id} persona.`,
    `Act on services, logs and tests only through the ${mcpName} MCP server; it serves this workspace.`,
  ];
  if (persona.context.length)
    lines.push(`Read first: ${persona.context.join("; ")}.`);
  return `${lines.join("\n")}\n\n${persona.prompt}`;
}
