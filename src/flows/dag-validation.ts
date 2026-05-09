import { namedTask } from "../execution.js";
import type { SubagentTask } from "../types.js";

export type NormalizedDagTask = SubagentTask & { name: string; dependsOn: string[] };

export interface DagValidationIssue {
	code: "duplicate_name" | "missing_dependency" | "self_dependency" | "cycle";
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
	return {
		tasks: tasksWithDependsOn,
		issues,
	};
}
