/**
 * The header version pill's text: the running Den's own version (its
 * package.json, from /api/server-info), prerelease suffix and all
 * ("v0.3.0-dev.5"). The changelog's newest heading names the release being
 * built ("0.3.0"), not this build, so it is only the fallback.
 */
export function versionLabel(serverVersion, changelog) {
  const v =
    (typeof serverVersion === "string" && serverVersion.trim()) ||
    changelog?.[0]?.version;
  return v ? `v${v}` : null;
}
