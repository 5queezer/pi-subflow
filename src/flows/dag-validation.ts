import { namedTask } from "../execution.js";
import { collectWhenTaskReferences, WhenExpressionError } from "./dag-when.js";
import type { SubagentTask } from "../types.js";

export type NormalizedDagTask = SubagentTask & { name: string; dependsOn: string[] };

export interface DagValidationIssue {
	code: "duplicate_name" | "missing_dependency" | "self_dependency" | "cycle" | "invalid_when" | "missing_when_task" | "when_task_not_dependency";
	message: string;
	task?: string;
	dependency?: string;
	path?: string[];
}

export interface DagValidationResult {
	tasks: NormalizedDagTask[];
	issues: DagValidationIssue[];
}

export function validateDagTasks(tasks: SubagentTask[]): DagValidationResult {
	const named = tasks.map((task, index) => namedTask(task, index));
	const issues: DagValidationIssue[] = [];
	const seen = new Set<string>();
	for (const task of named) {
		if (seen.has(task.name)) {
			issues.push({ code: "duplicate_name", message: `duplicate DAG task name: ${task.name}`, task: task.name });
			continue;
		}
		seen.add(task.name);
	}
	const nonVerifierNames = named.filter((task) => task.role !== "verifier").map((task) => task.name);
	const tasksWithDependsOn = named.map((task) => ({
		...task,
		dependsOn: task.role === "verifier" && task.dependsOn === undefined ? nonVerifierNames : (task.dependsOn ?? []),
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
