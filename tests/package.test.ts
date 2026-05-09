import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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

test("workflow template examples are shipped and indexed", async () => {
	const readme = await readFile("README.md", "utf8");
	const templateNames = [
		"code-review",
		"implementation-planning",
		"research-synthesis",
		"docs-consistency",
		"bug-investigation",
	];

	for (const name of templateNames) {
		const path = `examples/workflows/${name}.yaml`;
		const template = await readFile(path, "utf8");
		assert.match(readme, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(template, /role: verifier/);
		assert.match(template, /needs: \[/);
		assert.match(template, /model: openai-codex\/gpt-5\.4-mini/);
		assert.match(template, /model: openai-codex\/gpt-5\.5/);
		for (const sectionList of template.matchAll(/expectedSections: \[([^\]]+)\]/g)) {
			for (const rawSection of sectionList[1].split(",")) {
				const section = rawSection.trim();
				assert.match(template, new RegExp(`## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			}
		}
	}
});

test("workflow templates advertise the DAG YAML schema", async () => {
	const readme = await readFile("README.md", "utf8");
	const schemaPath = "schemas/subflow-dag.schema.json";
	const schema = JSON.parse(await readFile(schemaPath, "utf8"));
	await stat(schemaPath);

	assert.equal(schema.title, "pi-subflow DAG YAML");
	assert.equal(schema.type, "object");
	assert.match(readme, /schemas\/subflow-dag\.schema\.json/);
	assert.match(readme, /yaml-language-server: \$schema=/);

	for (const name of ["code-review", "implementation-planning", "research-synthesis", "docs-consistency", "bug-investigation"]) {
		const template = await readFile(`examples/workflows/${name}.yaml`, "utf8");
		assert.equal(template.split(/\r?\n/, 1)[0], "# yaml-language-server: $schema=https://raw.githubusercontent.com/5queezer/pi-subflow/refs/heads/master/schemas/subflow-dag.schema.json");
	}
});
