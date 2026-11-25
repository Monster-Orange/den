// Issue 296: the test files that start Docker containers.
//
// On a Linux machine, each container Docker starts or removes adds or
// drops a network interface on the host (its veth on the bridge).
// Chromium watches the host's interfaces: on any such change it fails
// every request it has in flight with net::ERR_NETWORK_CHANGED. A browser
// test loading a page at that moment loses a script (the shell never
// boots) and waits out its whole time limit. So on CI these files never
// run beside the browser tests: DEN_TEST_DOCKER=skip runs everything
// else, DEN_TEST_DOCKER=only runs just these, one step after the other.
//
// tests/unit/test-infra/docker-suites.test.ts fails when a test file
// starts containers and is not listed here.
export const DOCKER_SUITES = [
  "tests/unit/edge/access-log.integration.test.ts",
  "tests/unit/edge/edge-proof-traefik.integration.test.ts",
  "tests/unit/edge/upstream-idle.integration.test.ts",
  "tests/unit/edge/edge-include-takeover.integration.test.ts",
  "tests/unit/edge/edge-proof-labels.integration.test.ts",
  // Issue 455: the routes for another proxy, each in its official image.
  "tests/unit/edge/proxy-route.integration.test.ts",
];

/** A regex for a path that is one of these files. */
export const dockerSuiteRegex = () =>
  "/(" + DOCKER_SUITES.map((f) => f.replace(/[.]/g, "\\.")).join("|") + ")$";
