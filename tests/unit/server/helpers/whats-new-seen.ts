import type { BrowserContext } from "playwright";

const newest = new Map<string, Promise<string>>();

export function newestVersion(base: string): Promise<string> {
  let v = newest.get(base);
  if (!v) {
    v = fetch(`${base}/api/changelog`)
      .then((r) => r.json() as Promise<{ version: string }[]>)
      .then((list) => {
        const top = list[0]?.version;
        if (!top) throw new Error(`${base}/api/changelog has no entries`);
        return top;
      });
    v.catch(() => newest.delete(base));
    newest.set(base, v);
  }
  return v;
}

export async function seeWhatsNew(
  ctx: BrowserContext,
  base: string,
): Promise<void> {
  const version = await newestVersion(base);
  await ctx.addInitScript((seen) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, seen);
    } catch (e) {
      void e;
    }
  }, version);
}
