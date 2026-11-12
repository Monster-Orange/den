/**
 * AG-DROP-2: `agents.files.deny`, files inside an agent's roots that are
 * still never a link or a download: a repo's secrets. Globs, matched
 * after the fence (agent-paths.ts) against the path below its root.
 *
 *   - A glob without `/` matches any one part of that path (a file's name,
 *     or a folder it is in): `.env` refuses `app/.env` and `.env/x`.
 *   - A glob with `/` matches the whole path below the root:
 *     `config/secrets/**`.
 *   - `*` is any run within one part, `**` any run of parts, `?` one
 *     character. Case never counts: `.ENV` is `.env`.
 *
 * The list replaces the defaults; `deny: []` turns it off.
 */

export interface FileSettings {
  deny: string[];
}

export const FILE_DENY_DEFAULTS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
];

export const FILE_DEFAULTS: FileSettings = { deny: [...FILE_DENY_DEFAULTS] };

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `agents.files`, checked, with its defaults. */
export function filesBlock(v: unknown): FileSettings {
  const out: FileSettings = { deny: [...FILE_DENY_DEFAULTS] };
  if (v === undefined || v === null) return out;
  if (!isMapping(v))
    throw new Error(
      `agents.files: must be a mapping with deny (got ${JSON.stringify(v)})`,
    );
  for (const [k, x] of Object.entries(v)) {
    if (k !== "deny")
      throw new Error(
        `agents.files.${k}: unknown key (agents.files takes deny)`,
      );
    if (
      !Array.isArray(x) ||
      x.some((g) => typeof g !== "string" || !g.trim() || g.includes("\0"))
    )
      throw new Error(
        `agents.files.deny: must be a list of globs, such as ".env" or "*.pem" (got ${JSON.stringify(x)})`,
      );
    out.deny = (x as string[]).map((g) => g.trim());
  }
  return out;
}

function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  // Any case: a case-insensitive disk (macOS) opens `.ENV` as `.env`.
  return new RegExp(`^${re}$`, "i");
}

/** Whether `rel` (a path below a root, `/`-separated) is denied. */
export function denied(rel: string, deny: readonly string[]): boolean {
  if (!deny.length || !rel) return false;
  const parts = rel.split("/").filter(Boolean);
  const whole = parts.join("/");
  return deny.some((g) => {
    const clean = g.replace(/^\/+|\/+$/g, "");
    const re = globRe(clean);
    return clean.includes("/")
      ? re.test(whole)
      : parts.some((p) => re.test(p));
  });
}
