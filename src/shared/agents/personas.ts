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
 * Den's own keys sit beside them (AG-10.2): `display_name` ("Rita", shown
 * as "Rita (reviewer)"), `role` (a key into the role registry, roles.ts:
 * planner, sde, …; a sentence there, as before AG-10, is read as the
 * description), `category` (engineering, design, …; default from the
 * role), `version` ("latest" or a pinned model version),
 * `allowed_commands` (plain command prefixes run without asking: AG-13.4),
 * `runtime` (default den-claude),
 * `standing` (starts with its workspace, §5; resumes after a restart),
 * `resume_on_restart` (AG-14.3: resumes after a restart too), `context` (what to read
 * first), `argv` (the generic runtime's template), and `permission_mode`
 * (Den's intent: ask, edits or all; or a Claude Code mode, which
 * den-claude checks), and
 * `den_hooks` / `den_instructions` (true or false: this persona's
 * guardrails, guardrails.ts, over its pack's). Any other key (a
 * Claude Code `color`) is ignored. A file without front matter (a pack's
 * README) is not a persona.
 *
 * Where personas come from (AG-10.3), each with its origin: built-in
 * (Den's default pack), distribution (agents.persona_packs) and local
 * (<state_dir>/personas/*.md, made in the UI or by hand: persona-store.ts).
 * Of two with one id, local wins over distribution, and distribution over
 * built-in. Hub comes later; only its origin value exists now.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { WORKSPACE_NAME_RE } from "../agent-actor.js";
import { checkCommands } from "./permissions.js";
import { DEN_ROLES, REGISTRY_ID_RE } from "./roles.js";
import { enginePath } from "../engine.js";
import {
  DEFAULT_PACK_GUARDRAILS,
  PACK_GUARDRAILS,
  sharedInstructions,
  type Guardrails,
} from "./guardrails.js";

/** Where a persona came from (AG-10.3). */
export type PersonaOrigin = "builtin" | "distribution" | "local" | "hub";
export const PERSONA_ORIGINS: readonly PersonaOrigin[] = [
  "builtin",
  "distribution",
  "local",
  "hub",
];

export interface Persona {
  id: string;
  /** A person's name for it ("Rita"), shown as "Rita (reviewer)". */
  displayName?: string;
  /** Its role: a key into the role registry (roles.ts), when it has one. */
  role?: string;
  /** One line: what it does. */
  description: string;
  /** Its category (roles.ts): the role's, else engineering. */
  category: string;
  /** "latest" (default) or a pinned version of its model. */
  version?: string;
  /** Plain command prefixes it may run without asking (AG-13.4). */
  allowedCommands: string[];
  /** Where it came from (loadPersonas sets it). */
  origin: PersonaOrigin;
  /** The role prompt: the file's body. */
  prompt: string;
  /** The runtime it runs on unless an agent says otherwise. */
  runtime?: string;
  /** The model it runs unless an agent says otherwise. */
  model?: string;
  /** Started with its workspace (planner, orchestrator). */
  standing: boolean;
  /**
   * `resume_on_restart: true` (AG-14.3): resumed on its own when Den or
   * the machine restarted. Standing personas always are.
   */
  resumeOnRestart?: boolean;
  /** Tool hints. */
  tools: string[];
  /** What to read first (specs, the design system, workspace config). */
  context: string[];
  /** The generic runtime's argv template ({model}, {mcp_config}). */
  argv?: string[];
  /** `permission_mode`: the runtime's permission mode (den-claude checks it). */
  permissionMode?: string;
  /** `den_hooks` / `den_instructions` as its front matter sets them. */
  guardrailsSet?: Partial<Guardrails>;
  /**
   * Den's guardrails for it (guardrails.ts), resolved by loadPersonas from
   * its pack and its own front matter. Absent: none.
   */
  guardrails?: Guardrails;
  /** The file it came from. */
  source: string;
}

/** A model version as a persona pins it: "latest" or a version id. */
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,63}$/;

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
export function parsePersona(
  text: string,
  file: string,
  origin: PersonaOrigin = "builtin",
): Persona | null {
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
  const resumeOnRestart = f.resume_on_restart ?? false;
  if (typeof resumeOnRestart !== "boolean")
    throw new Error(`${file}: resume_on_restart must be true or false`);
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
  const displayName = optString(f, "display_name", file);
  if (
    displayName &&
    ([...displayName].length > 40 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(displayName))
  )
    throw new Error(
      `${file}: display_name must be at most 40 characters, with no control characters`,
    );
  // AG-10.2: `role` is a role key; a sentence there (before AG-10) is the
  // description it always was.
  const roleRaw = optString(f, "role", file);
  const role = roleRaw && REGISTRY_ID_RE.test(roleRaw) ? roleRaw : undefined;
  const category = optString(f, "category", file);
  if (category && !REGISTRY_ID_RE.test(category))
    throw new Error(
      `${file}: category "${category.slice(0, 40)}" must be lowercase letters, digits and "-"`,
    );
  const version = optString(f, "version", file);
  if (version && !VERSION_RE.test(version))
    throw new Error(
      `${file}: version must be "latest" or a version id (letters, digits, . _ @ : -)`,
    );
  let allowedCommands: string[];
  try {
    allowedCommands = checkCommands(f.allowed_commands, "allowed_commands");
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const runtime = optString(f, "runtime", file);
  const permissionMode = optString(f, "permission_mode", file);
  const guardrailsSet: Partial<Guardrails> = {};
  for (const [key, k] of [
    ["den_hooks", "hooks"],
    ["den_instructions", "instructions"],
  ] as const) {
    const v = f[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "boolean")
      throw new Error(`${file}: ${key} must be true or false`);
    guardrailsSet[k] = v;
  }
  return {
    id,
    ...(displayName ? { displayName } : {}),
    ...(role ? { role } : {}),
    description:
      (roleRaw && !role ? roleRaw : undefined) ??
      optString(f, "description", file) ??
      "",
    category:
      category ??
      DEN_ROLES.find((r) => r.id === role)?.category ??
      "engineering",
    ...(version && version !== "latest" ? { version } : {}),
    allowedCommands,
    origin,
    prompt: text.slice(m[0].length).trim(),
    ...(runtime ? { runtime } : {}),
    ...(model && model !== "inherit" ? { model } : {}),
    standing,
    ...(resumeOnRestart ? { resumeOnRestart } : {}),
    tools: stringList(f, "tools", file),
    context: stringList(f, "context", file),
    ...(argv ? { argv } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(Object.keys(guardrailsSet).length ? { guardrailsSet } : {}),
    source: file,
  };
}

/**
 * A pack's personas, by file name. A directory with an `agents/` inside (a
 * Claude Code plugin) is read from there.
 */
export function readPack(
  dir: string,
  origin: PersonaOrigin = "builtin",
): Persona[] {
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
    const p = parsePersona(fs.readFileSync(file, "utf-8"), file, origin);
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

/** Each pack's guardrails (guardrails.ts), as agents: configures them. */
export interface PackGuardrails {
  /** Den's default pack (default: both on). */
  defaultPack?: Partial<Guardrails>;
  /** Each of packDirs, in order (default: both off). */
  packs?: (Partial<Guardrails> | undefined)[];
}

/**
 * Every persona: Den's default pack, then each pack in order. A later
 * pack's persona replaces an earlier one of the same id. Each gets its
 * guardrails: its own front matter's, else its pack's.
 */
export function loadPersonas(
  packDirs: string[],
  defaultPack: string = DEFAULT_PACK_DIR,
  guardrails: PackGuardrails = {},
  /**
   * <state_dir>/personas (AG-10.3): a person's own, read last so one wins
   * over a pack's of the same id. Absent: none. They get the default
   * pack's guardrails (Den's hooks and instructions) unless their own
   * front matter says otherwise.
   */
  localDir?: string,
): Map<string, Persona> {
  const all = new Map<string, Persona>();
  const packs: [string, Guardrails, PersonaOrigin][] = [
    [
      defaultPack,
      { ...DEFAULT_PACK_GUARDRAILS, ...guardrails.defaultPack },
      "builtin",
    ],
    ...packDirs.map((dir, i): [string, Guardrails, PersonaOrigin] => [
      dir,
      { ...PACK_GUARDRAILS, ...guardrails.packs?.[i] },
      "distribution",
    ]),
  ];
  if (
    localDir &&
    fs.statSync(localDir, { throwIfNoEntry: false })?.isDirectory()
  )
    packs.push([localDir, { ...DEFAULT_PACK_GUARDRAILS }, "local"]);
  for (const [dir, g, origin] of packs)
    for (const p of readPack(dir, origin))
      all.set(p.id, { ...p, guardrails: { ...g, ...p.guardrailsSet } });
  return all;
}

/**
 * The role prompt as an agent gets it: who and where it is, what to read
 * first, the persona's own prompt, then Den's shared instructions
 * (guardrails/instructions.md) when its guardrails include them. Runtime-neutral; a runtime only
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
  const shared = persona.guardrails?.instructions
    ? `\n\n${sharedInstructions()}`
    : "";
  return `${lines.join("\n")}\n\n${persona.prompt}${shared}`;
}
