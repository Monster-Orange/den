interface NamedModule {
  name: string;
}

interface ResolvePerformanceModulesOptions {
  availableModules: NamedModule[];
  selectedModule?: string | null;
  repoName?: string | null;
}

export function resolvePerformanceModules({
  availableModules,
  selectedModule,
  repoName,
}: ResolvePerformanceModulesOptions): string[] {
  if (selectedModule) {
    return [selectedModule];
  }

  if (repoName) {
    const repoModules = availableModules
      .map((module) => module.name)
      .filter((name) => name.startsWith(`${repoName}/`));
    if (repoModules.length === 0) {
      throw new Error(`No performance modules found for repo "${repoName}"`);
    }
    return repoModules;
  }

  return availableModules.map((module) => module.name);
}
