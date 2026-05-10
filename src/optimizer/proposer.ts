import type { CandidateProposerInput, CandidateProposerResult } from "./types.js";

export async function proposeCandidates(input: CandidateProposerInput): Promise<CandidateProposerResult> {
	if (Boolean(input.workflowPath) === Boolean(input.dagYaml)) {
		throw new Error("Provide exactly one of workflowPath or dagYaml");
	}

	return {
		status: "completed",
		strategy: input.strategy ?? "safe",
		requestedCount: input.count ?? 3,
		proposals: [],
		summary: "No candidate proposals generated.",
	};
}
