/**
 * Roles and persona categories (AG-10.5, AG-11): two small registries.
 *
 * A role is a template and a dispatch key. Den owns planner, orchestrator,
 * sde, reviewer, tester and designer. Each has default instructions, a
 * permission mode and a command preset (plain command prefixes the agent
 * may run without asking). Picking a role in New persona fills the form in
 * (never over text already there), and the role adds nothing hidden to an
 * agent's prompt: what it receives is the persona's instructions.
 *
 * A distribution adds roles in its config (`agents.roles`), and may extend
 * a Den role's preset there, never redefine it:
 *
 *   agents:
 *     roles:
 *       copywriter: { description: …, instructions: …, mode: ask, preset: [], category: marketing }
 *       reviewer: { preset: [semgrep] }      # adds to Den's preset only
 *
 * Categories group personas in the Start list and Settings › Personas.
 * Den's are Engineering, Design, Product, Marketing and Operations; a
 * distribution adds more (`agents.categories: [{ id, label }]`).
 */
import { checkCommands, PERMISSION_INTENTS } from "./permissions.js";
import type { PermissionIntent } from "./permissions.js";

/** Where a role or category came from (hub: later, once Den Hub exists). */
export type RegistrySource = "den" | "distribution" | "project" | "hub";

export interface RoleTemplate {
  id: string;
  source: RegistrySource;
  /** One line: what a persona of this role does. */
  description: string;
  /** The starting instructions New persona fills in. */
  instructions: string;
  /** The starting permission mode. */
  mode: PermissionIntent;
  /** Plain command prefixes allowed without asking (AG-13.3). */
  preset: string[];
  /** The category a new persona of this role starts in. */
  category: string;
  /** Set when a distribution extended a Den role's preset. */
  extendedBy?: RegistrySource;
  /** The commands that extension added (shown apart from Den's). */
  extension?: string[];
}

export interface Category {
  id: string;
  label: string;
  source: RegistrySource;
}

/** A role or category id: lowercase letters, digits and "-", 1-32 long. */
export const REGISTRY_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Den's categories, in the order lists show them. */
export const DEN_CATEGORIES: readonly Category[] = [
  { id: "engineering", label: "Engineering", source: "den" },
  { id: "design", label: "Design", source: "den" },
  { id: "product", label: "Product", source: "den" },
  { id: "marketing", label: "Marketing", source: "den" },
  { id: "operations", label: "Operations", source: "den" },
];

/**
 * Den's roles. The presets are read-only commands only: a preset is
 * allowed without asking, so Den's defaults never let an agent change
 * anything unasked.
 */
export const DEN_ROLES: readonly RoleTemplate[] = [
  {
    id: "planner",
    source: "den",
    description:
      "Turns goals into small, ready stories with acceptance criteria.",
    instructions:
      "Read the workspace's specs and open work items. Split goals into stories small enough for one pull request, each with testable acceptance criteria. Hand ready stories to the orchestrator. Don't write code.",
    mode: "ask",
    preset: ["gh issue list", "gh issue view"],
    category: "engineering",
  },
  {
    id: "orchestrator",
    source: "den",
    description:
      "Hands ready stories to other agents and follows them to done.",
    instructions:
      "Take the next ready story in priority order and start the persona that fits it, one agent per story. Respect the workspace's concurrency cap. Ask a person before anything irreversible; never approve or merge.",
    mode: "ask",
    preset: ["gh issue list", "gh pr view"],
    category: "engineering",
  },
  {
    id: "sde",
    source: "den",
    description: "Implements one story, test first, and opens a pull request.",
    instructions:
      "Take one story. Write a failing test for each acceptance criterion first, then make it pass. Keep the change small, run the repo's checks, and open a pull request that says what you verified.",
    mode: "ask",
    preset: ["git status", "git diff", "git log"],
    category: "engineering",
  },
  {
    id: "reviewer",
    source: "den",
    description:
      "Reviews a pull request adversarially. Never approves or merges.",
    instructions:
      "Check the change against its story's acceptance criteria, then look for what wasn't tested: edge cases, failure paths, security. Verify each finding in the code and report them ranked by impact. Never approve, merge or push.",
    mode: "ask",
    preset: ["git diff", "git log", "gh pr diff", "gh pr view"],
    category: "engineering",
  },
  {
    id: "tester",
    source: "den",
    description: "Runs the test suites and reports failures with repro steps.",
    instructions:
      "Run the workspace's unit, integration and end-to-end suites. For each failure, write the exact repro and the smallest failing command. Don't fix code.",
    mode: "ask",
    preset: ["git status"],
    category: "engineering",
  },
  {
    id: "designer",
    source: "den",
    description: "Designs flows and screens with the design system.",
    instructions:
      "Start from the user's goal and the story's acceptance criteria. Compose from the design system's components, and describe every state (empty, loading, error, success) and narrow screens. Hand off a short spec the developers can build and test.",
    mode: "ask",
    preset: [],
    category: "design",
  },
];

const isMapping = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const shown = (v: unknown) =>
  (JSON.stringify(v) ?? "undefined").replace(/[^\x20-\x7e]/g, "?").slice(0, 60);

function line(where: string, v: unknown, max: number): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    [...v].length > max ||
    /[\p{Cc}\p{Cf}]/u.test(v)
  )
    throw new Error(
      `${where}: must be one line of 1-${max} characters, no control characters`,
    );
  return v.trim();
}

/**
 * `agents.categories` checked: a list of { id, label }. A Den category's
 * id is refused (it can't be renamed). Anything else throws, naming it.
 */
export function checkCategoriesConfig(raw: unknown): Category[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new Error("agents.categories: must be a list of { id, label }");
  const seen = new Set(DEN_CATEGORIES.map((c) => c.id));
  return raw.map((x, i) => {
    const where = `agents.categories[${i}]`;
    if (!isMapping(x))
      throw new Error(`${where}: must be a mapping { id, label }`);
    for (const k of Object.keys(x))
      if (k !== "id" && k !== "label")
        throw new Error(`${where}.${k}: unknown key (takes id, label)`);
    if (typeof x.id !== "string" || !REGISTRY_ID_RE.test(x.id))
      throw new Error(
        `${where}.id: ${shown(x.id)} must be lowercase letters, digits and "-" (1-32)`,
      );
    if (seen.has(x.id))
      throw new Error(`${where}.id: "${x.id}" is already a category`);
    seen.add(x.id);
    return {
      id: x.id,
      label: line(`${where}.label`, x.label, 40),
      source: "distribution" as const,
    };
  });
}

/** What `agents.roles` holds, checked (merged with Den's by roleRegistry). */
export interface RolesConfig {
  /** New roles. */
  added: RoleTemplate[];
  /** Den roles' preset extensions, by role id. */
  extended: Record<string, string[]>;
}

/**
 * `agents.roles` checked. A Den role takes `preset` only (an extension);
 * a new role takes description, instructions, mode, preset and category.
 * `categories` are the ids a new role's category may name.
 */
export function checkRolesConfig(
  raw: unknown,
  categories: readonly string[] = DEN_CATEGORIES.map((c) => c.id),
): RolesConfig {
  const out: RolesConfig = { added: [], extended: {} };
  if (raw === undefined || raw === null) return out;
  if (!isMapping(raw))
    throw new Error(
      "agents.roles: must be a mapping of role id to its template",
    );
  for (const [id, v] of Object.entries(raw)) {
    const where = `agents.roles.${id}`;
    if (!REGISTRY_ID_RE.test(id))
      throw new Error(
        `${where}: a role id must be lowercase letters, digits and "-" (1-32)`,
      );
    if (!isMapping(v)) throw new Error(`${where}: must be a mapping`);
    const den = DEN_ROLES.find((r) => r.id === id);
    if (den) {
      for (const k of Object.keys(v))
        if (k !== "preset")
          throw new Error(
            `${where}.${k}: ${id} is Den's role: a distribution may only extend its preset`,
          );
      out.extended[id] = checkCommands(v.preset, `${where}.preset`);
      continue;
    }
    const keys = ["description", "instructions", "mode", "preset", "category"];
    for (const k of Object.keys(v))
      if (!keys.includes(k))
        throw new Error(
          `${where}.${k}: unknown key (takes ${keys.join(", ")})`,
        );
    const mode = v.mode ?? "ask";
    if (!(PERMISSION_INTENTS as readonly unknown[]).includes(mode))
      throw new Error(
        `${where}.mode: ${shown(mode)} must be one of ${PERMISSION_INTENTS.join(", ")}`,
      );
    const category = v.category ?? "engineering";
    if (typeof category !== "string" || !categories.includes(category))
      throw new Error(
        `${where}.category: ${shown(category)} is not a category (${categories.join(", ")})`,
      );
    const instructions = v.instructions ?? "";
    if (typeof instructions !== "string" || instructions.length > 4000)
      throw new Error(
        `${where}.instructions: must be text of up to 4000 characters`,
      );
    out.added.push({
      id,
      source: "distribution",
      description: line(`${where}.description`, v.description, 200),
      instructions: instructions.trim(),
      mode: mode as PermissionIntent,
      preset: checkCommands(v.preset, `${where}.preset`),
      category,
    });
  }
  return out;
}

/** Den's roles with a distribution's extensions, then its new roles. */
export function roleRegistry(
  cfg: RolesConfig = { added: [], extended: {} },
): RoleTemplate[] {
  const den = DEN_ROLES.map((r) => {
    const ext = cfg.extended[r.id];
    if (!ext?.length) return { ...r, preset: [...r.preset] };
    return {
      ...r,
      preset: [...new Set([...r.preset, ...ext])],
      extendedBy: "distribution" as const,
      extension: [...ext],
    };
  });
  return [...den, ...cfg.added];
}

/** Den's categories, then a distribution's. */
export function categoryRegistry(extra: readonly Category[] = []): Category[] {
  return [...DEN_CATEGORIES, ...extra];
}

/** A role's command preset ([] for none, or a role that isn't registered). */
export function rolePreset(
  roles: readonly RoleTemplate[],
  role: string | undefined,
): string[] {
  return role ? (roles.find((r) => r.id === role)?.preset ?? []) : [];
}
