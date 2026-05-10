import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SubagentRunner, SubagentTask } from "../types.js";
import { evaluateOptimizerRun, loadWorkflowTasks } from "./evaluator.js";
import { formatOptimizerReport, writeOptimizerReport } from "./report.js";
import type { EvalSetInput, OptimizerReport } from "./types.js";

export interface SubflowOptimizeToolParams {
	workflowPath?: string;
	dagYaml?: string;
	evalSet: EvalSetInput;
	candidateDagYamls?: string[];
	maxCandidateRuns?: number;
	maxCost?: number;
	maxRunCost?: number;
	maxCandidateCost?: number;
	maxTotalCost?: number;
	maxConcurrency?: number;
	timeoutSeconds?: number;
}

export const subflowOptimizeParameterSchema = Type.Object({
	workflowPath: Type.Optional(Type.String({ minLength: 1 })),
	dagYaml: Type.Optional(Type.String({ minLength: 1 })),
	evalSet: Type.Object({
		path: Type.Optional(Type.String({ minLength: 1 })),
		inline: Type.Optional(Type.Any()),
	}),
	candidateDagYamls: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	maxCandidateRuns: Type.Optional(Type.Integer({ minimum: 1 })),
	maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	maxRunCost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	maxCandidateCost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	maxTotalCost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	maxConcurrency: Type.Optional(Type.Number()),
	timeoutSeconds: Type.Optional(Type.Number()),
});

export function createSubflowOptimizeTool(options: {
	discoverRunner: (input: { ctx: ExtensionContext; params: SubflowOptimizeToolParams }) => Promise<SubagentRunner> | SubagentRunner;
	validateCandidateTasks?: (input: { ctx: ExtensionContext; params: SubflowOptimizeToolParams; tasks: SubagentTask[] }) => void;
}) {
	return {
		name: "subflow_optimize",
		label: "Pi Subflow Optimizer",
		description: "Dry-run optimizer for pi-subflow DAG workflows using eval sets and candidate comparison.",
		promptSnippet: "subflow_optimize: dry-run optimizer for authored DAG workflows; evaluates a baseline and optional manual candidates against canonical eval sets without mutating workflow files.",
		promptGuidelines: [
			"Use subflow_optimize for ADR 0003 workflow optimization experiments, not for normal subagent delegation.",
			"canonical eval sets live under .pi/subflow/evals/*.yaml; inline evalSet is a convenience only and should be saved if useful.",
			"The tool does not mutate workflow files; future apply behavior must be a separate tool.",
			"MVP candidateDagYamls are manual comparison inputs only. This tool does not generate candidates; pass them in candidateDagYamls.",
			"Pass exactly one of workflowPath or dagYaml, and exactly one of evalSet.path or evalSet.inline.",
			"maxCandidateRuns is a positive-integer budget cap on candidate repetitions; it can reduce but not increase evalSet.scoring.minRunsPerCase.",
			"Use maxRunCost, maxCandidateCost, and maxTotalCost for distinct budgets; maxCost is a compatibility alias for per-candidate budget behavior.",
			"expectedSections/jsonSchema.required are structural gates only, not quality scores; recommendations require every eval case to define a quality scorer.",
			"Structural-only or single-run evals are profile-only and do not recommend candidates.",
			"Invalid candidate DAG YAMLs and policy/allowlist failures are reported per candidate and do not abort the whole optimizer run.",
		],
		renderShell: "self" as const,
		parameters: subflowOptimizeParameterSchema,
		renderCall(args: unknown) {
			const params = args as SubflowOptimizeToolParams;
			return new Text(`subflow_optimize ${params.workflowPath ?? "inline dagYaml"}`, 0, 0);
		},
		renderResult(result: { content?: Array<{ type: string; text?: string }> }) {
			return new Text((result.content ?? []).map((item) => item.text ?? "").filter(Boolean).join("\n"), 0, 0);
		},
		async execute(_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const params = rawParams as SubflowOptimizeToolParams;
			const runner = await options.discoverRunner({ ctx, params });
			const report = await evaluateOptimizerRun({
				cwd: ctx.cwd,
				workflowPath: params.workflowPath,
				dagYaml: params.dagYaml,
				evalSet: params.evalSet,
				candidateDagYamls: params.candidateDagYamls,
				maxCandidateRuns: params.maxCandidateRuns,
				maxCost: params.maxCost,
				maxRunCost: params.maxRunCost,
				maxCandidateCost: params.maxCandidateCost,
				maxTotalCost: params.maxTotalCost,
				maxConcurrency: params.maxConcurrency,
				timeoutSeconds: params.timeoutSeconds,
				runner,
				validateCandidateTasks: options.validateCandidateTasks ? (tasks) => options.validateCandidateTasks?.({ ctx, params, tasks }) : undefined,
				signal: signal ?? ctx.signal,
			});
			const reportPath = await writeOptimizerReport(ctx.cwd, report);
			return buildOptimizerToolResult(report, reportPath);
		},
	};
}

async function buildOptimizerToolResult(report: OptimizerReport, reportPath: string) {
	const text = `${formatOptimizerReport(report)}\nReport artifact: ${reportPath}`;
	return {
		content: [{ type: "text" as const, text }],
		details: { ...report, reportPath },
		isError: false,
	};
}

export async function collectOptimizerPolicyTasks(params: SubflowOptimizeToolParams, cwd: string): Promise<SubagentTask[]> {
	return loadWorkflowTasks({ cwd, workflowPath: params.workflowPath, dagYaml: params.dagYaml });
}
