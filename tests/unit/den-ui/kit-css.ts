/**
 * Reading the kit's CSS in a unit test, with no browser: the custom
 * properties a block sets, one declaration's value, and var() resolved as a
 * browser would. Shared by the theme tests (issues 788, 1137).
 */

/** CSS with its comments taken out. */
const bare = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The custom properties a CSS block sets, by name (the first block that has it). */
export function propsOf(css: string, selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of bare(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!selector.test(m[1].trim())) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      if (!(d[1] in out)) out[d[1]] = d[2].trim();
  }
  return out;
}

/** var() substitution, with fallbacks, as a browser resolves it. */
export function resolve(value: string, vars: Record<string, string>): string {
  let v = value;
  for (let i = 0; i < 10; i++) {
    const next = v.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g,
      (_m, name: string, fb?: string) => vars[name] ?? (fb ?? "").trim(),
    );
    if (next === v) break;
    v = next;
  }
  return v;
}

/** One declaration's value in a rule whose selector list names `sel`. */
export function declOf(css: string, sel: string, prop: string): string | null {
  for (const m of bare(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = m[1].split(",").map((s) => s.trim());
    if (!sels.includes(sel)) continue;
    const d = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(m[2]);
    if (d) return d[1].trim();
  }
  return null;
}

/** Every innermost rule (inside @media too), as its selectors and declarations. */
export function rulesOf(
  css: string,
): { sels: string[]; decls: Record<string, string> }[] {
  const out: { sels: string[]; decls: Record<string, string> }[] = [];
  for (const m of bare(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g))
      decls[d[1]] = d[2].trim();
    out.push({
      sels: m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      decls,
    });
  }
  return out;
}
