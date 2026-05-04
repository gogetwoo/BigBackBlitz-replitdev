/**
 * Cross-platform preinstall: require pnpm and remove npm/yarn lockfiles at repo root.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ua = process.env.npm_config_user_agent ?? "";
if (!ua.includes("pnpm/")) {
  console.error("Use pnpm instead of npm or yarn for this workspace.");
  process.exit(1);
}

const root = process.cwd();
for (const name of ["package-lock.json", "yarn.lock"]) {
  const p = join(root, name);
  if (!existsSync(p)) continue;
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}
