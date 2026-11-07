/**
 * A person's own personas (AG-10.3, AG-10.7): <state_dir>/personas/<id>.md,
 * each 0600 in a 0700 directory, written in the same format a pack uses
 * (Claude Code's agent markdown plus Den's keys: personas.ts), so a file
 * made here reads like one made by hand.
 *
 * Only these files are ever written or removed: a built-in or a
 * distribution's persona is read-only, and editing one makes a local
 * duplicate first (the caller's choice: the routes do). Every field is
 * checked strictly (checkPersonaInput): an unknown key, a control
 * character, a role, category, runtime, model or version that isn't
 * registered, or a command that isn't a plain prefix is refused, naming
 * the field. Nothing here runs a command or passes text to a shell.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { writePrivate } from "./records.js";
import { PERSONA_ID_RE } from "./personas.js";
import {
  checkCommands,
  checkIntent,
  type PermissionIntent,
} from "./permissions.js";
import type { RuntimeModel } from "./runtime.js";

/** Where a person's own personas live. */
export function localPersonasDir(stateDir: string): string {
  return path.join(stateDir, "personas");
}

/** What New persona and Edit send, checked. */
export interface PersonaInput {
  displayName?: string;
  role: string;
  category: string;
  description: string;
  instructions: string;
  runtime: string;
  model?: string;
  version: string;
  permission: PermissionIntent;
  allowedCommands: string[];
}

/** What a field may name: the registries and runtimes it is checked against. */
export interface PersonaChoices {
  roles: readonly string[];
  categories: readonly string[];
  runtimes: readonly { id: string; models: readonly RuntimeModel[] }[];
}

export const MAX_INSTRUCTIONS = 20_000;
export const MAX_DESCRIPTION = 200;
export const MAX_PERSONA_NAME = 40;

const KEYS = [
  "displayName",
  "role",
  "category",
  "description",
  "instructions",
  "runtime",
  "model",
  "version",
  "permission",
  "allowedCommands",
] as const;

/** A usage error: a field a person sent isn't what it may be. */
export class PersonaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaInputError";
  }
}

const shown = (v: unknown) =>
  (JSON.stringify(v) ?? "undefined").replace(/[^\x20-\x7e]/g, "?").slice(0, 60);

function oneLine(
  key: string,
  v: unknown,
  max: number,
  required: boolean,
): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new PersonaInputError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string")
    throw new PersonaInputError(`${key} must be a string`);
  const s = v.trim();
  if (!s) {
    if (required) throw new PersonaInputError(`${key} is required`);
    return undefined;
  }
  if ([...s].length > max)
    throw new PersonaInputError(`${key} must be at most ${max} characters`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s))
    throw new PersonaInputError(`${key} can't have control characters`);
  return s;
}

function oneOf(key: string, v: unknown, list: readonly string[]): string {
  if (typeof v !== "string" || !list.includes(v))
    throw new PersonaInputError(
      `${key}: ${shown(v)} is not one of ${list.join(", ") || "(none)"}`,
    );
  return v;
}

/**
 * A model and version for runtime `rt` (AG-12.3): the model one it offers
 * (none: no model), the version "latest" or one of that model's.
 */
export function checkModelChoice(
  rt: { id: string; models: readonly RuntimeModel[] },
  model: unknown,
  version: unknown,
): { model?: string; version: string } {
  const ver =
    version === undefined || version === null || version === ""
      ? "latest"
      : version;
  if (model === undefined || model === null || model === "") {
    if (ver !== "latest") throw new PersonaInputError("version needs a model");
    return { version: "latest" };
  }
  if (!rt.models.length)
    throw new PersonaInputError(`${rt.id} takes no model choice from Den`);
  const m = rt.models.find((x) => x.id === model);
  if (!m)
    throw new PersonaInputError(
      `model: ${shown(model)} is not one of ${rt.id}'s (${rt.models.map((x) => x.id).join(", ")})`,
    );
  if (
    ver !== "latest" &&
    !(typeof ver === "string" && m.versions.includes(ver))
  )
    throw new PersonaInputError(
      `version: ${shown(ver)} is not "latest" or one of ${m.id}'s (${m.versions.join(", ")})`,
    );
  return { model: m.id, version: ver as string };
}

/**
 * A persona as New persona or Edit sends it, checked against `choices`.
 * Throws PersonaInputError naming the first field that is wrong.
 */
export function checkPersonaInput(
  raw: unknown,
  choices: PersonaChoices,
): PersonaInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new PersonaInputError("a persona must be a JSON object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!(KEYS as readonly string[]).includes(k))
      throw new PersonaInputError(
        `${k}: unknown field (a persona takes ${KEYS.join(", ")})`,
      );
  const role = oneOf("role", r.role, choices.roles);
  const category = oneOf("category", r.category, choices.categories);
  const runtime = oneOf(
    "runtime",
    r.runtime,
    choices.runtimes.map((x) => x.id),
  );
  const rt = choices.runtimes.find((x) => x.id === runtime)!;
  const { model, version } = checkModelChoice(rt, r.model, r.version);
  let permission: PermissionIntent;
  let allowedCommands: string[];
  try {
    permission = checkIntent(r.permission ?? "ask", "permission");
    allowedCommands = checkCommands(r.allowedCommands, "allowedCommands");
  } catch (e) {
    throw new PersonaInputError((e as Error).message);
  }
  const instructions = r.instructions ?? "";
  if (typeof instructions !== "string")
    throw new PersonaInputError("instructions must be a string");
  const text = instructions.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new PersonaInputError("instructions are required");
  if (text.length > MAX_INSTRUCTIONS)
    throw new PersonaInputError(
      `instructions must be at most ${MAX_INSTRUCTIONS} characters`,
    );
  // Newlines and tabs only: no escape sequences, no bidi overrides.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text))
    throw new PersonaInputError("instructions can't have control characters");
  const displayName = oneLine(
    "displayName",
    r.displayName,
    MAX_PERSONA_NAME,
    false,
  );
  return {
    ...(displayName ? { displayName } : {}),
    role,
    category,
    description: oneLine("description", r.description, MAX_DESCRIPTION, true)!,
    instructions: text,
    runtime,
    ...(model ? { model } : {}),
    version,
    permission,
    allowedCommands,
  };
}

/** The persona file for `input`: front matter (YAML) and its instructions. */
export function personaMarkdown(id: string, input: PersonaInput): string {
  const fm: Record<string, unknown> = {
    name: id,
    ...(input.displayName ? { display_name: input.displayName } : {}),
    role: input.role,
    category: input.category,
    description: input.description,
    runtime: input.runtime,
    ...(input.model ? { model: input.model } : {}),
    version: input.version,
    permission_mode: input.permission,
    ...(input.allowedCommands.length
      ? { allowed_commands: input.allowedCommands }
      : {}),
  };
  return `---\n${yaml.stringify(fm).trimEnd()}\n---\n\n${input.instructions}\n`;
}

function fileOf(stateDir: string, id: string): string {
  if (!PERSONA_ID_RE.test(id))
    throw new PersonaInputError(`"${shown(id)}" is not a persona id`);
  return path.join(localPersonasDir(stateDir), `${id}.md`);
}

/** Whether a local persona file `id` exists. */
export function localPersonaExists(stateDir: string, id: string): boolean {
  return PERSONA_ID_RE.test(id) && fs.existsSync(fileOf(stateDir, id));
}

/** Write local persona `id` (0600, atomically). */
export function writeLocalPersona(
  stateDir: string,
  id: string,
  input: PersonaInput,
): string {
  const file = fileOf(stateDir, id);
  writePrivate(file, personaMarkdown(id, input));
  return file;
}

/** Remove local persona `id`; false when there was none. Only that file. */
export function deleteLocalPersona(stateDir: string, id: string): boolean {
  const file = fileOf(stateDir, id);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * A new persona's id: from its name (else its role), lowercased, made of
 * what an id may hold; "-2", "-3", … when taken.
 */
export function newPersonaId(
  input: Pick<PersonaInput, "displayName" | "role">,
  taken: ReadonlySet<string>,
): string {
  const base =
    (input.displayName ?? input.role)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "")
      .slice(0, 56) || "persona";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}
