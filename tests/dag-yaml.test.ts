import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNestedWorkflows, parseDagYaml } from "../src/dag-yaml.js";

test("parseDagYaml normalizes needs alias and preserves block-scalar task formatting", () => {
	const tasks = parseDagYaml(`
review:
  agent: reviewer
  task: |
    Review this snippet:
      if (ok) {
        return true;
      }
  needs:
    - plan
    - implement
`);

	assert.equal(tasks.length, 1);
	assert.equal(tasks[0].name, "review");
	assert.equal(tasks[0].dependsOn?.[0], "plan");
	assert.equal(tasks[0].dependsOn?.[1], "implement");
	assert.equal(tasks[0].task, "Review this snippet:\n  if (ok) {\n    return true;\n  }");
});

test("parseDagYaml rejects tasks with both needs and dependsOn", () => {
	assert.throws(
		() => parseDagYaml(`
bad:
  agent: worker
  task: one
  needs: [a]
  dependsOn: [b]
`),
		/dagYaml task bad cannot set both needs and dependsOn/,
	);
});

test("parseDagYaml rejects workflow.uses with workflow.dagYaml", () => {
	assert.throws(
		() => parseDagYaml(`
review:
  workflow:
    uses: ./pattern.yaml
    dagYaml: |
      api:
        agent: reviewer
        task: Review API
`),
		/dagYaml task review workflow cannot set uses with dagYaml or tasks/,
	);
});

test("parseDagYaml rejects workflow.uses with workflow.tasks", () => {
	assert.throws(
		() => parseDagYaml(`
review:
  workflow:
    uses: ./pattern.yaml
    tasks:
      api:
        agent: reviewer
        task: Review API
`),
		/dagYaml task review workflow cannot set uses with dagYaml or tasks/,
	);
});

test("normalizeNestedWorkflows parses nested dagYaml and loop body mappings", () => {
	const normalized = normalizeNestedWorkflows({
		tasks: [
			{
				name: "review",
				workflow: {
					dagYaml: `
api:
  agent: reviewer
  task: Review API
`,
				},
			},
			{
				name: "edit-cycle",
				loop: {
					maxIterations: 1,
					body: {
						research: {
							agent: "reviewer",
							task: "Gather facts",
						},
						edit: {
							workflow: {
								tasks: {
								step: { agent: "reviewer", task: "Edit" },
							},
							},
						},
					},
				},
			},
		],
	});

	assert.equal(normalized.tasks?.[0]?.workflow?.tasks?.[0]?.name, "api");

	const loopBody = normalized.tasks?.[1]?.loop?.body as Record<string, { name?: string; workflow?: { tasks?: unknown } }>;
	assert.equal(loopBody.research?.name, "research");
	assert.equal(Array.isArray(loopBody.edit?.workflow?.tasks), true);
	assert.equal((loopBody.edit?.workflow?.tasks as Array<{ name?: string }>)[0]?.name, "step");
});
