import pkg from "../package.json" with { type: "json" };

// Single source of truth: package.json `version`. The release workflow asserts
// the pushed git tag (vX.Y.Z) matches this, so a compiled binary always reports
// the exact version it was cut from.
export const CURRENT_VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";

// Where prebuilt releases live. Mirrors install.sh so `mongotui update` pulls
// from the same place the installer does; overridable for forks.
export const REPO: string = process.env.MONGOTUI_REPO || "hadijaveed/mongotui";
