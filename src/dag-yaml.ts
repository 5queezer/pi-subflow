import { parseDocument } from "yaml";
import type { SubagentTask } from "./types.js";

type WorkflowTasksValue = NonNullable<NonNullable<SubagentTask["workflow"]>["tasks"]>;

export type DagYamlParams = {
	dagYaml?: string;
	tasks?: SubagentTask[];
};

export function normalizeDagYaml<T extends object>(params: T & DagYamlParams): T & DagYamlParams {
	if (!params.dagYaml) return params;
	if ((params as DagYamlParams).tasks !== undefined) throw new Error("subflow accepts either dagYaml or tasks, not both");
	return { ...params, tasks: parseDagYaml(params.dagYaml) } as T & DagYamlParams;
}

export function normalizeNestedWorkflows<T extends object>(params: T & DagYamlParams): T & DagYamlParams {
	return {
		...params,
		tasks: params.tasks?.map((task) => normalizeTask(task)),
	} as T & DagYamlParams;
}

function normalizeTask(task: SubagentTask): SubagentTask {
	return {
		...task,
		workflow: normalizeWorkflowDefinition(task.workflow, task.name ?? task.agent ?? "workflow task"),
		loop: normalizeLoopDefinition(task.loop, task.name ?? task.agent ?? "loop task"),
	};
}

function normalizeLoopDefinition(loop: SubagentTask["loop"] | undefined, context: string): SubagentTask["loop"] | undefined {
	if (!loop) return undefined;
	return {
		...loop,
		body: normalizeLoopBody(loop.body, context),
	};
}

function normalizeWorkflowDefinition(workflow: SubagentTask["workflow"] | undefined, context: string): SubagentTask["workflow"] | undefined {
	if (!workflow) return undefined;
	if (workflow.dagYaml && workflow.tasks) throw new Error(`${context} workflow cannot set both dagYaml and tasks`);
	if (workflow.dagYaml) return { ...workflow, tasks: parseDagYaml(workflow.dagYaml) };
	if (workflow.uses) return workflow;
	return { ...workflow, tasks: normalizeWorkflowTasksValue(workflow.tasks, context) };
}

function normalizeWorkflowTasksValue(tasks: WorkflowTasksValue | undefined, context: string): SubagentTask[] | undefined {
	if (tasks === undefined) return undefined;
	if (Array.isArray(tasks)) return tasks.map((task, index) => normalizeTask({ ...task, name: task.name ?? `${task.agent ?? "task"}-${index + 1}` }));
	if (isRecord(tasks)) return Object.entries(tasks).map(([name, task]) => normalizeTask({ ...task, name: task.name ?? name }));
	throw new Error(`${context} workflow.tasks must be an array or mapping`);
}

export function parseDagYaml(source: string): SubagentTask[] {
	const document = parseDocument(source, { uniqueKeys: true });
	if (document.errors.length) {
		throw new Error(`invalid dagYaml: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	const root = document.toJSON();
	if (!isRecord(root) || Array.isArray(root) || !Object.keys(root).length) {
		throw new Error("dagYaml root must be a mapping of task names to task definitions");
	}
	return Object.entries(root).map(([name, value]) => parseDagYamlTask(name, value));
}

function parseDagYamlTask(name: string, value: unknown): SubagentTask {
	if (!isRecord(value) || Array.isArray(value)) throw new Error(`dagYaml task ${name} must be a mapping`);
	const workflow = parseDagYamlWorkflow(value.workflow, name);
	const loop = parseDagYamlLoop(value.loop, name);
	if (workflow && loop) throw new Error(`dagYaml task ${name} cannot set both workflow and loop`);
	if (value.dependsOn !== undefined && value.needs !== undefined) throw new Error(`dagYaml task ${name} cannot set both needs and dependsOn`);
	const dependsOn = parseStringArray(value.dependsOn ?? value.needs, `dagYaml task ${name} dependsOn`);
	const agent = optionalString(value.agent, `dagYaml task ${name} agent`);
	const task = optionalString(value.task, `dagYaml task ${name} task`);
	if (!workflow && !loop && (typeof agent !== "string" || typeof task !== "string")) throw new Error(`dagYaml task ${name} requires agent and task strings`);
	return {
		name,
		agent,
		task: task?.trimEnd(),
		workflow,
		loop,
		cwd: optionalString(value.cwd, `dagYaml task ${name} cwd`),
		dependsOn,
		when: optionalString(value.when, `dagYaml task ${name} when`),
		role: optionalRole(value.role, name),
		authority: optionalAuthority(value.authority, name),
		tools: parseStringArray(value.tools, `dagYaml task ${name} tools`),
		model: optionalString(value.model, `dagYaml task ${name} model`),
		thinking: optionalThinking(value.thinking, name),
		expectedSections: parseStringArray(value.expectedSections, `dagYaml task ${name} expectedSections`),
		jsonSchema: isRecord(value.jsonSchema) ? { required: parseStringArray(value.jsonSchema.required, `dagYaml task ${name} jsonSchema.required`) } : undefined,
	};
}

function parseDagYamlWorkflow(value: unknown, name: string): SubagentTask["workflow"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Array.isArray(value)) throw new Error(`dagYaml task ${name} workflow must be a mapping`);
	if (value.dagYaml !== undefined && value.tasks !== undefined) throw new Error(`dagYaml task ${name} workflow cannot set both dagYaml and tasks`);
	if (value.dagYaml !== undefined) return { dagYaml: optionalString(value.dagYaml, `dagYaml task ${name} workflow.dagYaml`), uses: optionalString(value.uses, `dagYaml task ${name} workflow.uses`) };
	return {
		tasks: parseWorkflowTasksValue(value.tasks, `dagYaml task ${name} workflow`),
		dagYaml: undefined,
		uses: optionalString(value.uses, `dagYaml task ${name} workflow.uses`),
	};
}

function parseDagYamlLoop(value: unknown, name: string): SubagentTask["loop"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Array.isArray(value)) throw new Error(`dagYaml task ${name} loop must be a mapping`);
	if (value.maxIterations === undefined) throw new Error(`dagYaml task ${name} loop requires maxIterations`);
	if (typeof value.maxIterations !== "number" || !Number.isFinite(value.maxIterations)) throw new Error(`dagYaml task ${name} loop maxIterations must be a number`);
	if (value.body === undefined) throw new Error(`dagYaml task ${name} loop requires body`);
	return {
		maxIterations: value.maxIterations,
		body: parseLoopBodyValue(value.body, `dagYaml task ${name} loop.body`),
		until: optionalString(value.until, `dagYaml task ${name} loop.until`),
	};
}

function parseLoopBodyValue(value: unknown, context: string): NonNullable<SubagentTask["loop"]>["body"] {
	if (Array.isArray(value)) return value.map((task, index) => parseWorkflowTask(task, `${context}[${index}]`, index + 1));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, task]) => [name, parseWorkflowTask(task, `${context}.${name}`, name)]));
	throw new Error(`${context} must be an array or mapping`);
}

function parseWorkflowTasksValue(tasks: unknown, context: string): SubagentTask[] | undefined {
	if (tasks === undefined) return undefined;
	if (Array.isArray(tasks)) return tasks.map((task, index) => parseWorkflowTask(task, `${context}[${index}]`, index + 1));
	if (isRecord(tasks)) return Object.entries(tasks).map(([name, task]) => parseWorkflowTask(task, `${context}.${name}`, name));
	throw new Error(`${context}.tasks must be an array or mapping`);
}

function parseWorkflowTask(value: unknown, context: string, name: string | number): SubagentTask {
	if (!isRecord(value) || Array.isArray(value)) throw new Error(`${context} must be a mapping`);
	if (value.dependsOn !== undefined && value.needs !== undefined) throw new Error(`${context} cannot set both needs and dependsOn`);
	const workflow = parseDagYamlWorkflow(value.workflow, `${context}`);
	const loop = parseDagYamlLoop(value.loop, `${context}`);
	if (workflow && loop) throw new Error(`${context} cannot set both workflow and loop`);
	const agent = optionalString(value.agent, `${context} agent`);
	const task = optionalString(value.task, `${context} task`);
	if (!workflow && !loop && (typeof agent !== "string" || typeof task !== "string")) throw new Error(`${context} requires agent and task strings`);
	return {
		name: typeof name === "string" ? name : optionalString(value.name, `${context} name`),
		agent,
		task: task?.trimEnd(),
		workflow,
		loop,
		cwd: optionalString(value.cwd, `${context} cwd`),
		dependsOn: parseStringArray(value.dependsOn ?? value.needs, `${context} dependsOn`),
		when: optionalString(value.when, `${context} when`),
		role: optionalRole(value.role, String(name)),
		authority: optionalAuthority(value.authority, String(name)),
		tools: parseStringArray(value.tools, `${context} tools`),
		model: optionalString(value.model, `${context} model`),
		thinking: optionalThinking(value.thinking, String(name)),
		expectedSections: parseStringArray(value.expectedSections, `${context} expectedSections`),
		jsonSchema: isRecord(value.jsonSchema) ? { required: parseStringArray(value.jsonSchema.required, `${context} jsonSchema.required`) } : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
	return value;
}

function optionalRole(value: unknown, name: string): SubagentTask["role"] | undefined {
	if (value === undefined) return undefined;
	if (value === "worker" || value === "verifier") return value;
	throw new Error(`dagYaml task ${name} role must be worker or verifier`);
}

function optionalAuthority(value: unknown, name: string): SubagentTask["authority"] | undefined {
	if (value === undefined) return undefined;
	if (value === "read_only" || value === "internal_mutation" || value === "external_side_effect") return value;
	throw new Error(`dagYaml task ${name} authority must be read_only, internal_mutation, or external_side_effect`);
}

function optionalThinking(value: unknown, name: string): SubagentTask["thinking"] | undefined {
	if (value === undefined) return undefined;
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	throw new Error(`dagYaml task ${name} thinking must be off, minimal, low, medium, high, or xhigh`);
}

function normalizeLoopBody(tasks: NonNullable<SubagentTask["loop"]>["body"], context: string): NonNullable<SubagentTask["loop"]>["body"] {
	if (Array.isArray(tasks)) return tasks.map((task, index) => normalizeTask({ ...task, name: task.name ?? `${task.agent ?? "task"}-${index + 1}` }));
	if (isRecord(tasks)) return Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, normalizeTask({ ...task, name: task.name ?? name })]));
	throw new Error(`${context} loop body must be an array or mapping`);
}
