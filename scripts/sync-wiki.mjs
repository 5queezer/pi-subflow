#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const sourceDir = resolve("doc/wiki");
let wikiDir = process.env.WIKI_DIR ? resolve(process.env.WIKI_DIR) : resolve("..", "pi-subflow.wiki");
let push = false;

for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	if (arg === "--push") {
		push = true;
	} else if (arg === "--wiki-dir") {
		const value = args[index + 1];
		if (!value) throw new Error("--wiki-dir requires a path");
		wikiDir = resolve(value);
		index += 1;
	} else {
		throw new Error(`Unknown argument: ${arg}`);
	}
}

async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

if (!(await pathExists(sourceDir))) throw new Error(`Missing source directory: ${sourceDir}`);
if (!(await pathExists(join(wikiDir, ".git")))) {
	throw new Error(`Wiki checkout not found at ${wikiDir}. Clone git@github.com:5queezer/pi-subflow.wiki.git or pass --wiki-dir.`);
}

await mkdir(wikiDir, { recursive: true });

for (const entry of await readdir(wikiDir)) {
	if (entry.endsWith(".md")) await rm(join(wikiDir, entry), { force: true });
}

const sourceEntries = (await readdir(sourceDir)).filter((entry) => entry.endsWith(".md")).sort();
for (const entry of sourceEntries) {
	await cp(join(sourceDir, entry), join(wikiDir, basename(entry)));
}

console.log(`Synced ${sourceEntries.length} wiki pages from ${sourceDir} to ${wikiDir}`);

if (push) {
	execFileSync("git", ["-C", wikiDir, "add", "-A"], { stdio: "inherit" });
	execFileSync("git", ["-C", wikiDir, "commit", "-m", "Sync wiki from repository doc"], { stdio: "inherit" });
	execFileSync("git", ["-C", wikiDir, "push"], { stdio: "inherit" });
}
