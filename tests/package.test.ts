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

test("package.json configures Husky pre-commit verification", async () => {
	const pkg = JSON.parse(await readFile("package.json", "utf8"));
	const hook = await readFile(".husky/pre-commit", "utf8");

	assert.equal(pkg.scripts.prepare, "husky");
	assert.match(pkg.devDependencies.husky, /^\^/);
	assert.match(hook, /npm run build && npm test/);
});

test("docs describe DAG validation boundary and future workflow IR", async () => {
	const readme = await readFile("README.md", "utf8");
	const adr = await readFile("docs/adr/0001-pocketflow-orchestration-core.md", "utf8");

	assert.match(readme, /DAG[\s\S]*preflight[\s\S]*validation/);
	for (const concept of ["conditional branches", "nested workflows", "dynamic dependency graphs"]) {
		assert.match(readme, new RegExp(concept));
	}
	assert.match(adr, /DAG[\s\S]*validation[\s\S]*boundary/);
	assert.match(adr, /graph librar(?:y|ies)/);
});
