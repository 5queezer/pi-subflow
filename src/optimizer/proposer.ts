import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { normalizeDagYaml, normalizeNestedWorkflows } from "../dag-yaml.js";
import { validateDagTasks } from "../flows/dag-validation.js";
import type { SubagentTask } from "../types.js";
import type { CandidateProposal, CandidateProposerInput, CandidateProposerResult } from "./types.js";

export async function proposeCandidates(input: CandidateProposerInput): Promise<CandidateProposerResult> {
	if (Boolean(input.workflowPath) === Boolean(input.dagYaml)) {
		throw new Error("Provide exactly one of workflowPath or dagYaml");
	}

	const sourceDagYaml = input.dagYaml ?? (await readFile(resolve(input.workflowPath ?? ""), "utf8"));
	const tasks = loadDagTasks(sourceDagYaml);
	const proposal = buildVerifierFanInCandidate(tasks);
	const requestedCount = input.count ?? 3;
	const proposals = proposal && requestedCount > 0 ? [proposal] : [];
	const validCount = proposals.filter((candidate) => candidate.valid).length;

	return {
		status: "completed",
		strategy: input.strategy ?? "safe",
		requestedCount,
		proposals,
		summary: validCount > 0 ? "Generated 1 valid verifier fan-in candidate." : "No verifier fan-in candidate generated.",
	};
}

function loadDagTasks(dagYaml: string): SubagentTask[] {
	return normalizeNestedWorkflows(normalizeDagYaml({ dagYaml })).tasks ?? [];
}

function buildVerifierFanInCandidate(tasks: SubagentTask[]): CandidateProposal | undefined {
	const workerRoots = tasks.filter((task) => (task.dependsOn?.length ?? 0) === 0 && task.role !== "verifier");
	if (workerRoots.length < 2) return undefined;
	const rootNames = workerRoots.map((task) => task.name).filter((name): name is string => typeof name === "string");
	if (rootNames.length < 2) return undefined;
	if (hasExistingVerifierFanIn(tasks, rootNames)) return undefined;

	const synthesisName = uniqueTaskName(tasks, "synthesis");
	const candidateTasks = [...tasks, {
		name: synthesisName,
		agent: "verifier",
		task: "Synthesize the research and repository evidence into a concise recommendation.",
		dependsOn: [...rootNames],
		role: "verifier" as const,
	}];
	const dagYaml = renderDagYaml(candidateTasks);
	const validation = validateRenderedDagYaml(dagYaml);
	if (!validation.valid) {
		return {
			id: "verifier-fan-in-1",
			title: "Verifier fan-in synthesis candidate",
			explanation: `Generated ${synthesisName} to fan in ${rootNames.join(", ")}.`,
			dagYaml,
			valid: false,
			errors: validation.errors,
		};
	}

	return {
		id: "verifier-fan-in-1",
		title: "Verifier fan-in synthesis candidate",
		explanation: `Generated ${synthesisName} to fan in ${rootNames.join(", ")}.`,
		dagYaml,
		valid: true,
		errors: [],
	};
}

function hasExistingVerifierFanIn(tasks: SubagentTask[], rootNames: string[]): boolean {
	const rootSet = new Set(rootNames);
	return tasks.some((task) => {
		if (task.role !== "verifier") return false;
		const dependsOn = task.dependsOn ?? [];
		if (dependsOn.length === 0) return true;
		return rootNames.every((name) => dependsOn.includes(name)) && dependsOn.every((name) => rootSet.has(name));
	});
}

function uniqueTaskName(tasks: SubagentTask[], baseName: string): string {
	const names = new Set(tasks.map((task) => task.name).filter((name): name is string => typeof name === "string"));
	if (!names.has(baseName)) return baseName;
	let suffix = 2;
	while (names.has(`${baseName}-${suffix}`)) suffix += 1;
	return `${baseName}-${suffix}`;
}

function renderDagYaml(tasks: SubagentTask[]): string {
	const mapping = Object.fromEntries(tasks.map((task) => [task.name ?? "task", serializeDagTask(task)]));
	return `${YAML.stringify(mapping)}
`;
}

function serializeDagTask(task: SubagentTask): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	if (task.agent !== undefined) output.agent = task.agent;
	if (task.task !== undefined) output.task = task.task;
	if (task.cwd !== undefined) output.cwd = task.cwd;
	if (task.dependsOn !== undefined) output.dependsOn = [...task.dependsOn];
	if (task.when !== undefined) output.when = task.when;
	if (task.role !== undefined) output.role = task.role;
	if (task.authority !== undefined) output.authority = task.authority;
	if (task.tools !== undefined) output.tools = [...task.tools];
	if (task.model !== undefined) output.model = task.model;
	if (task.thinking !== undefined) output.thinking = task.thinking;
	if (task.expectedSections !== undefined) output.expectedSections = [...task.expectedSections];
	if (task.jsonSchema !== undefined) output.jsonSchema = { ...task.jsonSchema };
	if (task.workflow !== undefined) output.workflow = serializeWorkflow(task.workflow);
	if (task.loop !== undefined) output.loop = serializeLoop(task.loop);
	return output;
}

function serializeWorkflow(workflow: NonNullable<SubagentTask["workflow"]>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	if (workflow.tasks !== undefined) {
		output.tasks = Array.isArray(workflow.tasks)
			? workflow.tasks.map((task) => serializeDagTask(task))
			: Object.fromEntries(Object.entries(workflow.tasks).map(([name, task]) => [name, serializeDagTask(task)]));
	}
	if (workflow.dagYaml !== undefined) output.dagYaml = workflow.dagYaml;
	if (workflow.uses !== undefined) output.uses = workflow.uses;
	return output;
}

function serializeLoop(loop: NonNullable<SubagentTask["loop"]>): Record<string, unknown> {
	const output: Record<string, unknown> = { maxIterations: loop.maxIterations };
	output.body = Array.isArray(loop.body)
		? loop.body.map((task) => serializeDagTask(task))
		: Object.fromEntries(Object.entries(loop.body).map(([name, task]) => [name, serializeDagTask(task)]));
	if (loop.until !== undefined) output.until = loop.until;
	return output;
}

function validateRenderedDagYaml(dagYaml: string): { valid: boolean; errors: string[] } {
	try {
		const tasks = normalizeNestedWorkflows(normalizeDagYaml({ dagYaml })).tasks ?? [];
		const validation = validateDagTasks(tasks);
		return validation.issues.length === 0 ? { valid: true, errors: [] } : { valid: false, errors: validation.issues.map((issue) => issue.message) };
	} catch (error) {
		return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
	}
}
