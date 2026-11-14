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
