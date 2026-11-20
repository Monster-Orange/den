/**
 * D80: what counts as an install's address (web.url), with no imports, so
 * `create` (which runs outside any distribution) can check `--url`.
 */
/** A name that means this machine only: never the install's address (D80). */
export function isLoopbackName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\./.test(h) ||
    h === "0.0.0.0"
  );
}

/** Why `url` (an origin checkWebUrl gave) can't be the address; else null. */
export function loopbackRefusal(url: string): string | null {
  return isLoopbackName(new URL(url).hostname)
    ? `${url} names this machine only: the address is the name other devices open`
    : null;
}

/** `s` as an address Den gives people: an http(s) origin; else why not. */
export function checkWebUrl(s: unknown): { url: string } | { error: string } {
  if (typeof s !== "string" || !s.trim())
    return { error: "the address is empty" };
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return {
      error: `"${String(s)}" is not an address (for example https://acme.local.example.com)`,
    };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { error: `"${String(s)}" must start with https:// or http://` };
  if (u.username || u.password)
    return { error: "the address must not carry a user name or password" };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    return {
      error: "the address is the server's alone: no path, query or #",
    };
  if (!u.hostname) return { error: "the address needs a host name" };
  return { url: u.origin };
}

/** Whether `url` (any string) is an address naming this machine only. */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return isLoopbackName(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Issue 666: of an install's edge addresses, the ones that can be its
 * address: valid origins, never loopback, https first.
 */
export function aliasCandidates(urls: readonly string[]): string[] {
  const ok = urls
    .map((u) => checkWebUrl(u))
    .flatMap((r) => ("url" in r && !isLoopbackUrl(r.url) ? [r.url] : []));
  const uniq = [...new Set(ok)];
  return [
    ...uniq.filter((u) => u.startsWith("https:")),
    ...uniq.filter((u) => !u.startsWith("https:")),
  ];
}
