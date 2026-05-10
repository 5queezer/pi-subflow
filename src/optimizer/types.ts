import type { FlowResult, SubagentTask } from "../types.js";

export interface OptimizerObjectiveWeights {
	taskScore: number;
	cost: number;
	latency: number;
	instability: number;
	complexity: number;
}

export interface OptimizerScoringPolicy {
	minRunsPerCase: number;
	minUtilityDelta: number;
	maxFailureRateRegression: number;
}

export interface EvalCaseScorer {
	type: "judge";
	agent: string;
	model?: string;
	thinking?: SubagentTask["thinking"];
	tools?: string[];
	rubric: EvalCaseRubricCriterion[];
}

export interface EvalCaseRubricCriterion {
	name: string;
	description: string;
	weight: number;
}

export interface EvalCase {
	name: string;
	input: string;
	split: "train" | "holdout";
	entryTasks?: string[];
	expectedSections?: string[];
	jsonSchema?: {
		required?: string[];
	};
	scorer?: EvalCaseScorer;
}

export interface EvalSet {
	name: string;
	workflow?: string;
	objective: OptimizerObjectiveWeights;
	scoring: OptimizerScoringPolicy;
	cases: EvalCase[];
}

export type EvalSetInput = { path: string; inline?: never } | { inline: EvalSet; path?: never };

export interface LoadedEvalSet {
	evalSet: EvalSet;
	source: { kind: "path"; path: string; canonical: boolean } | { kind: "inline" };
	persistenceRecommendation?: string;
}

export interface GraphMetrics {
	runnableTasks: number;
	edges: number;
	conditionals: number;
	nestedWorkflowDepth: number;
	loopExpansionBound: number;
	syntheticSummaryNodes: number;
	complexity: number;
}

export interface CandidateEvaluation {
	id: string;
	label: string;
	status: "completed" | "failed" | "invalid";
	dagYaml?: string;
	error?: string;
	metrics?: EvaluationMetrics;
	trainMetrics?: EvaluationMetrics;
	holdoutMetrics?: EvaluationMetrics;
	utility?: number;
	trainUtility?: number;
	holdoutUtility?: number;
	graph?: GraphMetrics;
}

export interface EvaluationMetrics {
	taskScore: number;
	dollarCost: number;
	wallTimeMs: number;
	failureRate: number;
	runs: number;
	failures: number;
	qualityAssessedRuns: number;
	profileOnly: boolean;
}

export interface OptimizerReport {
	reportId: string;
	createdAt: string;
	evalSetName: string;
	source: LoadedEvalSet["source"];
	persistenceRecommendation?: string;
	baseline: CandidateEvaluation;
	candidates: CandidateEvaluation[];
	recommendation: string;
	warnings: string[];
}

export type CandidateProposalStrategy = "safe" | "exploratory" | "model-thinking";

export type CandidateProposerInput = {
	workflowPath?: string;
	dagYaml?: string;
	evalSet?: {
		path?: string;
		inline?: unknown;
	};
	count?: number;
	strategy?: CandidateProposalStrategy;
};

export type CandidateProposal = {
	id: string;
	title: string;
	explanation: string;
	dagYaml: string;
	valid: boolean;
	errors: string[];
};

export type CandidateProposerResult = {
	status: "completed" | "failed";
	strategy: CandidateProposalStrategy;
	requestedCount: number;
	proposals: CandidateProposal[];
	summary: string;
};

export interface WorkflowCandidate {
	id: string;
	label: string;
	tasks: SubagentTask[];
	dagYaml?: string;
}

export interface CaseRunResult {
	caseName: string;
	split: EvalCase["split"];
	result: FlowResult;
	wallTimeMs: number;
	taskScore: number;
	structuralPassed: boolean;
	qualityAssessed: boolean;
	scorerOutput?: unknown;
}
