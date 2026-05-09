import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("package.json exposes only the public package entrypoint", async () => {
	const pkg = JSON.parse(await readFile("package.json", "utf8"));

	assert.deepEqual(pkg.exports, {
		".": {
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		},
	});
});
