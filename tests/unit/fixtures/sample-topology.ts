/**
 * A generic 12-service sample topology used as a fixture by the derivation
 * tests. It is NOT the shipped default (see DEFAULT_ALIASES in
 * src/shared/environment-manager/derivation/alias.ts).
 */
export const SAMPLE_ALIASES: Record<string, string[]> = {
  "infra-stack": ["localstack", "infra"],
  shop: ["shop-api", "shop-backend", "backend", "shop.backend"],
  "shop-web": ["frontend", "app", "shop.web"],
  "files-api": ["files", "files-sdk", "files-sdk-go"],
  "links-api": ["links", "links-sdk"],
  "billing-api": ["billing", "billing-sdk", "billing-service", "shop.billing"],
  tokens: ["token", "token-service", "tokens-sdk"],
  "notes-api": ["notes", "notes-events"],
  "search-api": ["search", "search-sdk"],
  "jobs-runtime": ["job-runner", "code-executor", "shop.jobs-runtime"],
  "control-plane": ["shop.control-plane"],
  "tasks-api": ["tool-catalog"],
};

/** The same map rendered as a `graph.aliases:` YAML block (2-space indented). */
export function sampleAliasesYaml(indent = "  "): string[] {
  return [
    `${indent}aliases:`,
    ...Object.entries(SAMPLE_ALIASES).map(
      ([k, v]) =>
        `${indent}  ${JSON.stringify(k)}: [${v.map((t) => JSON.stringify(t)).join(", ")}]`,
    ),
  ];
}
