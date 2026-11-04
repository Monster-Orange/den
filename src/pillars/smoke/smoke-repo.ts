/**
 * The repo a smoke run targets. Always named by the caller (`make
 * test-smoke repo=<name>` / the web UI set SMOKE_REPO); the engine has no
 * default repo, so a missing name fails loudly instead of guessing one.
 */
export function smokeRepoName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.SMOKE_REPO?.trim();
  if (!name) {
    console.error(
      "\n❌ SMOKE_REPO is not set: name the repo whose smoke tests to run " +
        "(make test-smoke repo=<name>).\n",
    );
    process.exit(1);
  }
  return name;
}
