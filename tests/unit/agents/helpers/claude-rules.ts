/**
 * Claude Code's documented permission rule syntax, modelled for tests (the
 * real `claude` never runs):
 *
 *   - `Bash(<pattern>)` with `*` matches any run of characters, at any
 *     position, against the whole command; a compound command (`&&`,
 *     `||`, `;`, `|`) is checked part by part, and any part denied denies it;
 *   - the legacy `Bash(<prefix>:*)` matches commands that start with
 *     `<prefix>` followed by a space and arguments;
 *   - `Read(/<abs>)` is one file, `Read(/<abs>/**)` everything under it;
 *     a `*` inside the path matches one path segment (gitignore style).
 */

/** Whether one Bash rule matches one simple command. */
export function ruleMatches(rule: string, cmd: string): boolean {
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return false;
  const body = m[1];
  if (body.endsWith(":*")) {
    const prefix = body.slice(0, -2);
    return cmd.startsWith(prefix + " ");
  }
  const re = new RegExp(
    "^" +
      body
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[\\s\\S]*") +
      "$",
  );
  return re.test(cmd);
}

/** Whether the rules deny a (possibly compound) command. */
export function denied(rules: string[], command: string): boolean {
  return command
    .split(/&&|\|\||;|\|/)
    .map((c) => c.trim())
    .filter(Boolean)
    .some((c) => rules.some((r) => ruleMatches(r, c)));
}

/** Whether a Read rule covers an absolute file path. */
export function readDenied(rules: string[], file: string): boolean {
  return rules
    .filter((r) => r.startsWith("Read(/"))
    .map((r) => r.slice("Read(/".length, -1))
    .some((g) => {
      const under = g.endsWith("/**");
      const re = new RegExp(
        "^" +
          (under ? g.slice(0, -3) : g)
            .split("*")
            .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*") +
          (under ? "/.+" : "") +
          "$",
      );
      return re.test(file);
    });
}
