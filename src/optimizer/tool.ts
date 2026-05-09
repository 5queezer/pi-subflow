import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { normalizeDagYaml, normalizeNestedWorkflows } from "../dag-yaml.js";
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
	maxCandidateRuns: Type.Optional(Type.Number()),
	maxCost: Type.Optional(Type.Number()),
	maxConcurrency: Type.Optional(Type.Number()),
	timeoutSeconds: Type.Optional(Type.Number()),
});

export function createSubflowOptimizeTool(options: {
	discoverRunner: (input: { ctx: ExtensionContext; params: SubflowOptimizeToolParams }) => Promise<SubagentRunner> | SubagentRunner;
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
			"Pass exactly one of workflowPath or dagYaml, and exactly one of evalSet.path or evalSet.inline.",
			"Invalid candidate DAG YAMLs are reported and not run.",
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
				maxConcurrency: params.maxConcurrency,
				timeoutSeconds: params.timeoutSeconds,
				runner,
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

function collectBaselineAndCandidateTasks(params: SubflowOptimizeToolParams, baselineTasks: SubagentTask[]): SubagentTask[] {
	const candidateTasks = (params.candidateDagYamls ?? []).flatMap((dagYaml) => {
		try {
			return normalizeNestedWorkflows(normalizeDagYaml({ dagYaml })).tasks ?? [];
		} catch {
			return [];
		}
	});
	return [...baselineTasks, ...candidateTasks];
}

export async function collectOptimizerPolicyTasks(params: SubflowOptimizeToolParams, cwd: string): Promise<SubagentTask[]> {
	const baselineTasks = await loadWorkflowTasks({ cwd, workflowPath: params.workflowPath, dagYaml: params.dagYaml });
	return collectBaselineAndCandidateTasks(params, baselineTasks);
}
