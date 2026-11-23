/**
 * A path as the request log writes it: a sign-in or pairing request's id
 * is its credential while it waits (SEC-2a: the code request's, a GitHub
 * flow's, a `web login` wait's), so it shows as `:id`.
 */
export function loggedPath(pathname: string): string {
  return pathname.replace(
    /^(\/api\/(?:signin\/code|github\/signin|web\/owner\/link|web\/logins))\/[^/]+(\/withdraw)?$/,
    "$1/:id$2",
  );
}
