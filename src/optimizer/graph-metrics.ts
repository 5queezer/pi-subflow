import type { SubagentTask } from "../types.js";
import type { GraphMetrics } from "./types.js";

export function computeGraphMetrics(tasks: SubagentTask[]): GraphMetrics {
	const counts = countTasks(tasks, 0);
	const complexity = counts.runnableTasks
		+ counts.edges * 0.25
		+ counts.conditionals * 0.75
		+ counts.nestedWorkflowDepth * 1.5
		+ counts.loopExpansionBound * 0.5
		+ counts.syntheticSummaryNodes * 0.5;
	return { ...counts, complexity };
}

function countTasks(tasks: SubagentTask[], depth: number): Omit<GraphMetrics, "complexity"> {
	let runnableTasks = 0;
	let edges = 0;
	let conditionals = 0;
	let nestedWorkflowDepth = depth;
	let loopExpansionBound = 0;
	let syntheticSummaryNodes = 0;
	for (const task of tasks) {
		edges += task.dependsOn?.length ?? 0;
		if (task.when) conditionals += 1;
		if (task.workflow?.tasks) {
			syntheticSummaryNodes += 1;
			const childTasks = normalizeTaskCollection(task.workflow.tasks);
			const child = countTasks(childTasks, depth + 1);
			runnableTasks += child.runnableTasks;
			edges += child.edges;
			conditionals += child.conditionals;
			nestedWorkflowDepth = Math.max(nestedWorkflowDepth, child.nestedWorkflowDepth);
			loopExpansionBound += child.loopExpansionBound;
			syntheticSummaryNodes += child.syntheticSummaryNodes;
			continue;
		}
		if (task.loop) {
			syntheticSummaryNodes += 1;
			loopExpansionBound += task.loop.maxIterations;
			const bodyTasks = normalizeTaskCollection(task.loop.body);
			const body = countTasks(bodyTasks, depth);
			runnableTasks += body.runnableTasks * task.loop.maxIterations;
			edges += body.edges * task.loop.maxIterations;
			conditionals += body.conditionals * task.loop.maxIterations;
			nestedWorkflowDepth = Math.max(nestedWorkflowDepth, body.nestedWorkflowDepth);
			loopExpansionBound += body.loopExpansionBound * task.loop.maxIterations;
			syntheticSummaryNodes += body.syntheticSummaryNodes * task.loop.maxIterations;
			continue;
		}
		runnableTasks += 1;
	}
	return { runnableTasks, edges, conditionals, nestedWorkflowDepth, loopExpansionBound, syntheticSummaryNodes };
}

function normalizeTaskCollection(tasks: SubagentTask[] | Record<string, SubagentTask>): SubagentTask[] {
	return Array.isArray(tasks) ? tasks : Object.entries(tasks).map(([name, task]) => ({ ...task, name: task.name ?? name }));
}
