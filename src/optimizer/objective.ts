import type { FlowResult, UsageStats } from "../types.js";
import type { CaseRunResult, EvaluationMetrics, GraphMetrics, OptimizerObjectiveWeights } from "./types.js";

export function summarizeRuns(runs: CaseRunResult[]): EvaluationMetrics {
	const failures = runs.filter((run) => run.result.status !== "completed").length;
	const dollarCost = runs.reduce((sum, run) => sum + usageCost(run.result.usage), 0);
	const wallTimeMs = runs.reduce((sum, run) => sum + run.wallTimeMs, 0);
	const qualityAssessedRuns = runs.filter((run) => run.qualityAssessed).length;
	return {
		taskScore: runs.length === 0 ? 0 : runs.reduce((sum, run) => sum + (run.taskScore ?? (run.result.status === "completed" ? 1 : 0)), 0) / runs.length,
		dollarCost,
		wallTimeMs,
		failureRate: runs.length === 0 ? 1 : failures / runs.length,
		runs: runs.length,
		failures,
		qualityAssessedRuns,
		profileOnly: runs.length > 0 && qualityAssessedRuns === 0,
	};
}

export function computeUtility(metrics: EvaluationMetrics, graph: Pick<GraphMetrics, "complexity">, weights: OptimizerObjectiveWeights): number {
	return metrics.taskScore * weights.taskScore
		- metrics.dollarCost * weights.cost
		- (metrics.wallTimeMs / 1000) * weights.latency
		- metrics.failureRate * weights.instability
		- graph.complexity * weights.complexity;
}

function usageCost(usage: FlowResult["usage"] | UsageStats | undefined): number {
	return typeof usage?.cost === "number" ? usage.cost : 0;
}
