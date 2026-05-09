import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");
const target = join(distDir, "node_modules");

if (!existsSync("node_modules")) {
  process.exit(0);
}

await mkdir(distDir, { recursive: true });

try {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) process.exit(0);
  await rm(target, { recursive: true, force: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await symlink("../node_modules", target, "dir");
