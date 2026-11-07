/**
 * The runtime catalog (AG-0.5): every vendor CLI Den knows how to find,
 * shipped as data with each release. An entry says:
 *
 *   id        the runtime's id ("den-claude", "codex")
 *   vendor    who makes it ("Anthropic")
 *   name      its name for people ("Claude Code")
 *   bins      its executable names, in order
 *   version   args: what prints its version ("--version"); identity: how
 *             a path is known to be this runtime, not just any program that
 *             prints a version (its output names it, it lives in the
 *             vendor's npm package, or under the vendor's install dir).
 *             A path someone sets is refused unless one of these holds.
 *   dirs      its well-known install directories: "~/…", an absolute
 *             path, "$NAME" (an install-dir variable the vendor's installer
 *             honours; skipped when unset) or "{system}" (Homebrew's,
 *             /usr/local/bin and npm's global bin)
 *   launch    argv: its interactive CLI, "{bin}" first (the path found)
 *
 * Each built-in entry was checked against the vendor's own docs or
 * installer (the URLs beside it). A vendor with no official CLI is left
 * out (docs/distributions.md, Runtimes, says which, and why); nothing is
 * guessed.
 *
 * A distribution (`agents.runtime_catalog` in its config) and a person
 * (`agents.runtime_catalog` in config/local/user.yml) add entries, checked
 * by the same validator (validateCatalogEntry). An entry can't replace a
 * built-in one: a path is set with agents.runtimes.<id>.bin instead.
 */
import * as path from "path";

export interface CatalogIdentity {
  /** A case-insensitive pattern the version command's output matches. */
  output?: string;
  /** The npm package the binary resolves into (its package.json name). */
  package?: string;
  /** Directories ("~/…" or absolute) the binary resolves under. */
  realpath_under?: string[];
}

export interface CatalogEntry {
  id: string;
  vendor: string;
  name: string;
  bins: string[];
  version: { args: string[]; identity: CatalogIdentity };
  dirs: string[];
  launch: { argv: string[] };
}

/** The keys an entry takes (the validator refuses any other). */
const ENTRY_KEYS = [
  "id",
  "vendor",
  "name",
  "bins",
  "version",
  "dirs",
  "launch",
] as const;

/** Den's built-in catalog, in the order lists show them. */
export const BUILTIN_CATALOG: readonly CatalogEntry[] = [
  // Claude Code. https://code.claude.com/docs/en/setup: the native
  // installer's launcher is ~/.local/bin/claude; `claude --version` prints
  // "2.1.211 (Claude Code)"; npm package @anthropic-ai/claude-code;
  // Homebrew cask claude-code. ~/.claude/local is the older local install.
  {
    id: "den-claude",
    vendor: "Anthropic",
    name: "Claude Code",
    bins: ["claude"],
    version: {
      args: ["--version"],
      identity: {
        output: "\\(Claude Code\\)",
        package: "@anthropic-ai/claude-code",
        realpath_under: ["~/.local/share/claude"],
      },
    },
    dirs: ["~/.local/bin", "~/.claude/local", "{system}"],
    launch: { argv: ["{bin}"] },
  },
  // Codex CLI. https://github.com/openai/codex: binary `codex`, npm
  // @openai/codex, Homebrew cask codex. The standalone installer
  // (https://chatgpt.com/codex/install.sh → releases.openai.com) installs
  // to ${CODEX_INSTALL_DIR:-$HOME/.local/bin}/codex and reads the version
  // from `codex --version`; the CLI declares clap's version flag
  // (codex-rs/cli/src/main.rs, bin_name "codex").
  {
    id: "codex",
    vendor: "OpenAI",
    name: "Codex CLI",
    bins: ["codex"],
    version: {
      args: ["--version"],
      identity: { output: "codex", package: "@openai/codex" },
    },
    dirs: ["$CODEX_INSTALL_DIR", "~/.local/bin", "{system}"],
    launch: { argv: ["{bin}"] },
  },
  // Gemini CLI. https://github.com/google-gemini/gemini-cli: binary
  // `gemini`, npm @google/gemini-cli, Homebrew formula gemini-cli;
  // docs/cli/cli-reference.md: `--version`/`-v` "Show CLI version number
  // and exit" (the number only, so the package names it), and no
  // arguments starts the interactive REPL.
  {
    id: "gemini",
    vendor: "Google",
    name: "Gemini CLI",
    bins: ["gemini"],
    version: {
      args: ["--version"],
      identity: { output: "gemini", package: "@google/gemini-cli" },
    },
    dirs: ["{system}"],
    launch: { argv: ["{bin}"] },
  },
  // Grok Build. https://docs.x.ai/build/overview: install with
  // https://x.ai/cli/install.sh, run `grok` in a project directory. The
  // installer puts the binary in ~/.grok/downloads, links it as
  // ${GROK_BIN_DIR:-$HOME/.grok/bin}/grok (and into ~/.local/bin or
  // /usr/local/bin when that dir isn't on PATH), and checks it with
  // `grok --version`.
  {
    id: "grok",
    vendor: "xAI",
    name: "Grok Build",
    bins: ["grok"],
    version: {
      args: ["--version"],
      identity: { output: "grok", realpath_under: ["~/.grok"] },
    },
    dirs: ["$GROK_BIN_DIR", "~/.grok/bin", "~/.local/bin", "/usr/local/bin"],
    launch: { argv: ["{bin}"] },
  },
];

/** Den's own runtime ids that a catalog entry can't take. */
const RESERVED_IDS = ["generic"];
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_DIR_RE = /^\$[A-Z_][A-Z0-9_]*$/;
const PKG_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const isMapping = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const shown = (v: unknown) =>
  JSON.stringify(v)
    ?.replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 60) ?? "undefined";

function text(where: string, v: unknown, max = 60): string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error(`${where}: must be a name of 1-${max} characters`);
  return v.trim();
}

function list(
  where: string,
  v: unknown,
  each: (x: unknown, at: string) => string,
  { min = 1, max = 16 } = {},
): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max)
    throw new Error(`${where}: must be a list of ${min}-${max} entries`);
  return v.map((x, i) => each(x, `${where}[${i}]`));
}

function dirOk(at: string, x: unknown): string {
  if (
    typeof x === "string" &&
    (x === "{system}" ||
      ENV_DIR_RE.test(x) ||
      (x.startsWith("~/") && !x.includes("..")) ||
      (path.isAbsolute(x) && !x.includes("..")))
  )
    return x;
  throw new Error(
    `${at}: ${shown(x)} must be "~/…", an absolute path, "$NAME" or "{system}"`,
  );
}

/**
 * One catalog entry, checked; throws naming the key (`where`, e.g.
 * "agents.runtime_catalog[0]"). Never guesses a missing field.
 */
export function validateCatalogEntry(
  raw: unknown,
  where: string,
): CatalogEntry {
  if (!isMapping(raw)) throw new Error(`${where}: must be a mapping`);
  for (const k of Object.keys(raw))
    if (!(ENTRY_KEYS as readonly string[]).includes(k))
      throw new Error(
        `${where}.${k}: unknown key (an entry takes ${ENTRY_KEYS.join(", ")})`,
      );
  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id) || RESERVED_IDS.includes(id))
    throw new Error(
      `${where}.id: ${shown(id)} must be lowercase letters, digits and "-" (1-32), not ${RESERVED_IDS.join(", ")}`,
    );
  const bins = list(`${where}.bins`, raw.bins, (x, at) => {
    if (typeof x === "string" && BIN_RE.test(x)) return x;
    throw new Error(`${at}: ${shown(x)} must be an executable's name, no path`);
  });
  const version = raw.version;
  if (!isMapping(version))
    throw new Error(`${where}.version: must be a mapping { args, identity }`);
  for (const k of Object.keys(version))
    if (k !== "args" && k !== "identity")
      throw new Error(
        `${where}.version.${k}: unknown key (version takes args, identity)`,
      );
  const args = list(
    `${where}.version.args`,
    version.args,
    (x, at) => {
      if (typeof x === "string" && x.length <= 40 && !/[\0\n]/.test(x))
        return x;
      throw new Error(`${at}: must be an argument of up to 40 characters`);
    },
    { min: 1, max: 4 },
  );
  const idn = version.identity;
  if (!isMapping(idn))
    throw new Error(
      `${where}.version.identity: must be a mapping with output, package or realpath_under`,
    );
  const identity: CatalogIdentity = {};
  for (const [k, v] of Object.entries(idn)) {
    const at = `${where}.version.identity.${k}`;
    if (k === "output") {
      if (typeof v !== "string" || !v || v.length > 100)
        throw new Error(`${at}: must be a pattern of 1-100 characters`);
      try {
        new RegExp(v, "i");
      } catch {
        throw new Error(`${at}: ${shown(v)} is not a valid pattern`);
      }
      identity.output = v;
    } else if (k === "package") {
      if (typeof v !== "string" || !PKG_RE.test(v))
        throw new Error(`${at}: ${shown(v)} is not an npm package name`);
      identity.package = v;
    } else if (k === "realpath_under") {
      identity.realpath_under = list(at, v, (x, a) => dirOk(a, x)).map((d) => {
        if (d === "{system}" || d.startsWith("$"))
          throw new Error(`${at}: ${shown(d)} must be "~/…" or absolute`);
        return d;
      });
    } else
      throw new Error(
        `${at}: unknown key (identity takes output, package, realpath_under)`,
      );
  }
  if (!identity.output && !identity.package && !identity.realpath_under)
    throw new Error(
      `${where}.version.identity: needs output, package or realpath_under (how a path is known to be ${id})`,
    );
  const dirs = list(`${where}.dirs`, raw.dirs, (x, at) => dirOk(at, x), {
    min: 0,
    max: 16,
  });
  const launch = raw.launch;
  if (!isMapping(launch) || Object.keys(launch).some((k) => k !== "argv"))
    throw new Error(`${where}.launch: must be a mapping { argv: [...] }`);
  const argv = list(
    `${where}.launch.argv`,
    launch.argv,
    (x, at) => {
      if (typeof x === "string" && x.length <= 200 && !/[\0\n]/.test(x))
        return x;
      throw new Error(`${at}: must be an argument of up to 200 characters`);
    },
    { min: 1, max: 16 },
  );
  if (argv[0] !== "{bin}")
    throw new Error(
      `${where}.launch.argv[0]: must be "{bin}" (the path Den found)`,
    );
  return {
    id,
    vendor: text(`${where}.vendor`, raw.vendor),
    name: text(`${where}.name`, raw.name),
    bins,
    version: { args, identity },
    dirs,
    launch: { argv },
  };
}

/**
 * Extra entries (a distribution's, then user.yml's), checked; an id that
 * is already in the catalog (a built-in, or an earlier entry) is refused.
 */
export function validateCatalog(
  raw: unknown,
  where: string,
  taken: readonly string[] = BUILTIN_CATALOG.map((e) => e.id),
): CatalogEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new Error(`${where}: must be a list of runtime entries`);
  const ids = [...taken];
  return raw.map((x, i) => {
    const e = validateCatalogEntry(x, `${where}[${i}]`);
    if (ids.includes(e.id))
      throw new Error(
        `${where}[${i}].id: "${e.id}" is already in the catalog (set its path with agents.runtimes.${e.id}.bin instead)`,
      );
    ids.push(e.id);
    return e;
  });
}

/**
 * An entry's install directories on this machine: "~/" from HOME, "$NAME"
 * from the env (left out when unset), "{system}" as `system` gives them.
 */
export function entryDirs(
  e: Pick<CatalogEntry, "dirs">,
  home: string | undefined,
  env: NodeJS.ProcessEnv,
  system: (env: NodeJS.ProcessEnv) => string[],
): string[] {
  const out: string[] = [];
  for (const d of e.dirs) {
    if (d === "{system}") out.push(...system(env));
    else if (d.startsWith("$")) {
      const v = env[d.slice(1)];
      if (v && path.isAbsolute(v)) out.push(v);
    } else if (d.startsWith("~/")) {
      if (home) out.push(path.join(home, d.slice(2)));
    } else out.push(d);
  }
  return out;
}

/** A built-in entry by id. */
export function builtinEntry(id: string): CatalogEntry | undefined {
  return BUILTIN_CATALOG.find((e) => e.id === id);
}
