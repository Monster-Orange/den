/** "v<running>" with its prerelease suffix, else the changelog's newest, else null. */
export declare function versionLabel(
  running: string | null | undefined,
  changelog: { version: string }[],
): string | null;
export declare function setVersion(label: string, root?: ParentNode): void;
export declare function setUnread(on: boolean, root?: ParentNode): void;
