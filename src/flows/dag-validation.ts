import { namedTask } from "../execution.js";
import { collectWhenTaskReferences, WhenExpressionError } from "./dag-when.js";
import type { SubagentTask } from "../types.js";

export type NormalizedDagTask = SubagentTask & { name: string; agent: string; task: string; dependsOn: string[]; synthetic?: "workflow_summary" | "loop_summary" };

export interface DagValidationIssue {
	code: "duplicate_name" | "missing_dependency" | "self_dependency" | "cycle" | "invalid_when" | "missing_when_task" | "when_task_not_dependency" | "invalid_loop";
	message: string;
	task?: string;
	dependency?: string;
	path?: string[];
}

export interface DagValidationResult {
	tasks: NormalizedDagTask[];
	issues: DagValidationIssue[];
}

type WorkflowTasksInput = NonNullable<NonNullable<SubagentTask["workflow"]>["tasks"]>;
const MAX_LOOP_ITERATIONS = 100;

export function expandDagTasks(tasks: SubagentTask[]): NormalizedDagTask[] {
	return expandDagTaskList(tasks, [], "");
}

export function collectRunnableDagTasks(tasks: SubagentTask[]): NormalizedDagTask[] {
	return expandDagTasks(tasks).filter((task) => task.synthetic !== "workflow_summary");
}

export function validateDagTasks(tasks: SubagentTask[]): DagValidationResult {
	const normalizedTasks = expandDagTasks(tasks);
	const issues: DagValidationIssue[] = [];
	const seen = new Set<string>();
	for (const task of normalizedTasks) {
		if (seen.has(task.name)) {
			issues.push({ code: "duplicate_name", message: `duplicate DAG task name: ${task.name}`, task: task.name });
			continue;
		}
		seen.add(task.name);
	}
	const tasksWithDependsOn = normalizedTasks.map((task) => ({
		...task,
		dependsOn: task.dependsOn ?? [],
	}));
	const taskNames = new Set(tasksWithDependsOn.map((task) => task.name));
	for (const task of tasksWithDependsOn) {
		for (const dependency of task.dependsOn) {
			if (dependency === task.name) {
				issues.push({ code: "self_dependency", message: `task ${task.name} cannot depend on itself`, task: task.name, dependency });
			} else if (!taskNames.has(dependency)) {
				issues.push({ code: "missing_dependency", message: `task ${task.name} depends on missing task ${dependency}`, task: task.name, dependency });
			}
		}
	}
	for (const task of tasksWithDependsOn) {
		if (task.loop) {
			if (!Number.isInteger(task.loop.maxIterations) || task.loop.maxIterations <= 0) {
				issues.push({ code: "invalid_loop", message: `task ${task.name} loop maxIterations must be a positive integer`, task: task.name });
			} else if (task.loop.maxIterations > MAX_LOOP_ITERATIONS) {
				issues.push({ code: "invalid_loop", message: `task ${task.name} loop maxIterations must be at most ${MAX_LOOP_ITERATIONS}`, task: task.name });
			}
			const bodyNames = loopBodyTaskNames(task.loop.body);
			if (bodyNames.length === 0) {
				issues.push({ code: "invalid_loop", message: `task ${task.name} loop requires body tasks`, task: task.name });
			}
			if (task.loop.until) {
				try {
					for (const reference of collectWhenTaskReferences(task.loop.until)) {
						if (!bodyNames.includes(reference)) issues.push({ code: "invalid_loop", message: `task ${task.name} loop until references missing body task ${reference}`, task: task.name, dependency: reference });
					}
				} catch (error) {
					const message = error instanceof WhenExpressionError ? error.message : error instanceof Error ? error.message : String(error);
					issues.push({ code: "invalid_loop", message: `task ${task.name} has invalid loop until expression: ${message}`, task: task.name });
				}
			}
		}
		if (!task.when) continue;
		let references: string[];
		try {
			references = collectWhenTaskReferences(task.when);
		} catch (error) {
			const message = error instanceof WhenExpressionError ? error.message : error instanceof Error ? error.message : String(error);
			issues.push({ code: "invalid_when", message: `task ${task.name} has invalid when expression: ${message}`, task: task.name });
			continue;
		}
		for (const dependency of new Set(references)) {
			if (!taskNames.has(dependency)) {
				issues.push({ code: "missing_when_task", message: `task ${task.name} when references missing task ${dependency}`, task: task.name, dependency });
			} else if (!task.dependsOn.includes(dependency)) {
				issues.push({ code: "when_task_not_dependency", message: `task ${task.name} when references task ${dependency} but does not depend on it`, task: task.name, dependency });
			}
		}
	}
	if (issues.length === 0) {
		const cycle = findCycle(tasksWithDependsOn);
		if (cycle) issues.push({ code: "cycle", message: `dependency cycle: ${cycle.join(" -> ")}`, path: cycle });
	}
	return {
		tasks: tasksWithDependsOn,
		issues,
	};
}

export function planDagStages<T extends { name: string; dependsOn?: string[] }>(tasks: T[]): T[][] {
	const seen = new Set<string>();
	for (const task of tasks) {
		if (seen.has(task.name)) throw new Error(`duplicate DAG task name: ${task.name}`);
		seen.add(task.name);
	}
	const taskNames = new Set(tasks.map((task) => task.name));
	for (const task of tasks) {
		for (const dependency of task.dependsOn ?? []) {
			if (!taskNames.has(dependency)) throw new Error(`task ${task.name} depends on missing task ${dependency}`);
		}
	}
	const cycle = findCycle(tasks);
	if (cycle) throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
	const remaining = new Map(tasks.map((task) => [task.name, task]));
	const completed = new Set<string>();
	const stages: T[][] = [];
	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((task) => (task.dependsOn ?? []).every((dep) => completed.has(dep)));
		if (ready.length === 0) throw new Error(`dependency cycle: ${[...remaining.keys()].join(" -> ")}`);
		stages.push(ready);
		for (const task of ready) {
			remaining.delete(task.name);
			completed.add(task.name);
		}
	}
	return stages;
}

export function expandDagTaskList(tasks: SubagentTask[], inheritedDependsOn: string[], prefix: string): NormalizedDagTask[] {
	const namedTasks = tasks.map((task, index) => {
		if (task.workflow && !task.name) throw new Error("nested workflow tasks require a name");
		return task.workflow ? task as SubagentTask & { name: string } : namedTask(task, index);
	});
	const localNonVerifierNames = namedTasks.filter((task) => task.role !== "verifier").map((task) => qualifyName(prefix, task.name));
	return namedTasks.flatMap((task) => {
		const verifierFanIn = task.role === "verifier" && (task.dependsOn === undefined || task.dependsOn.length === 0) && localNonVerifierNames.length > 0;
		return expandDagTask(task, inheritedDependsOn, prefix, verifierFanIn ? localNonVerifierNames : undefined);
	});
}

function expandDagTask(task: SubagentTask & { name: string }, inheritedDependsOn: string[], prefix: string, scopedVerifierFanIn?: string[]): NormalizedDagTask[] {
	const taskName = qualifyName(prefix, task.name);
	const localDependsOn = scopedVerifierFanIn ?? (task.dependsOn && task.dependsOn.length > 0 ? task.dependsOn.map((dependency) => qualifyName(prefix, dependency)) : inheritedDependsOn);
	if (task.workflow && task.loop) throw new Error(`task ${taskName} cannot set both workflow and loop`);
	if (task.loop) {
		return [{ ...task, name: taskName, agent: task.agent ?? "workflow", task: task.task ?? `summary for ${taskName}`, dependsOn: localDependsOn, synthetic: "loop_summary" }];
	}
	if (!task.workflow) {
		if (!task.agent || !task.task) throw new Error(`task ${taskName} requires agent and task`);
		return [{ ...task, name: taskName, agent: task.agent, task: task.task, dependsOn: localDependsOn }];
	}
	const childTasks = normalizeWorkflowTasks(task.workflow.tasks, taskName);
	if (childTasks.length === 0) throw new Error(`workflow task ${taskName} requires nested tasks`);
	const expandedChildren = expandDagTaskList(childTasks, localDependsOn, taskName);
	const terminalNames = getTerminalNodeNames(expandedChildren);
	return [
		...expandedChildren,
		{
			name: taskName,
			agent: task.agent ?? "workflow",
			task: task.task ?? `summary for ${taskName}`,
			cwd: task.cwd,
			dependsOn: terminalNames,
			role: task.role,
			authority: task.authority,
			tools: task.tools,
			model: task.model,
			thinking: task.thinking,
			expectedSections: task.expectedSections,
			jsonSchema: task.jsonSchema,
			synthetic: "workflow_summary",
		},
	];
}

function normalizeWorkflowTasks(tasks: WorkflowTasksInput | undefined, prefix: string): Array<SubagentTask & { name: string }> {
	if (tasks === undefined) return [];
	if (Array.isArray(tasks)) return tasks.map((task, index) => {
		if (task.workflow && !task.name) throw new Error(`nested workflow task ${prefix}.${index + 1} requires a name`);
		return namedTask(task, index);
	});
	if (isRecord(tasks)) return Object.entries(tasks).map(([name, task]) => ({ ...task, name: task.name ?? name }));
	throw new Error(`workflow tasks for ${prefix} must be an array or mapping`);
}

function loopBodyTaskNames(tasks: SubagentTask[] | Record<string, SubagentTask>): string[] {
	if (Array.isArray(tasks)) return tasks.map((task, index) => task.name ?? `${task.agent}-${index + 1}`);
	if (isRecord(tasks)) return Object.entries(tasks).map(([name, task]) => task.name ?? name);
	return [];
}

function qualifyName(prefix: string, name: string): string {
	return prefix ? `${prefix}.${name}` : name;
}

function getTerminalNodeNames(tasks: NormalizedDagTask[]): string[] {
	const dependentNames = new Set<string>();
	for (const task of tasks) {
		for (const dependency of task.dependsOn ?? []) dependentNames.add(dependency);
	}
	return tasks.filter((task) => !dependentNames.has(task.name)).map((task) => task.name);
}

function findCycle<T extends { name: string; dependsOn?: string[] }>(tasks: T[]): string[] | undefined {
	const byName = new Map(tasks.map((task) => [task.name, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const path: string[] = [];

	const visit = (name: string): string[] | undefined => {
		if (visiting.has(name)) {
			const start = path.indexOf(name);
			return [...path.slice(start), name];
		}
		if (visited.has(name)) return;
		const task = byName.get(name);
		if (!task) return;
		visiting.add(name);
		path.push(name);
		for (const dep of task.dependsOn ?? []) {
			const cycle = visit(dep);
			if (cycle) return cycle;
		}
		path.pop();
		visiting.delete(name);
		visited.add(name);
	};

	for (const task of tasks) {
		const cycle = visit(task.name);
		if (cycle) return cycle;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
