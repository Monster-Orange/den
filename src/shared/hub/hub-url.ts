/**
 * The check on a Hub address (hub.url), with no imports: `create` runs it
 * before the distribution it makes exists (issue 727).
 */
/** A URL Den will send a token to: https, or http to this machine. */
export function hubUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `hub.url is not a URL: ${url}`;
  }
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    return `hub.url must be https (http only to this machine): ${url}`;
  return null;
}
