import type { AgentScope } from "./agents.js";
import type { SubagentTask } from "./types.js";

export interface ExecutionPolicyInput {
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	hasUI?: boolean;
	riskTolerance?: "low" | "medium" | "high";
	allowExternalSideEffectWithoutConfirmation?: boolean;
	tasks?: SubagentTask[];
}

export function validateExecutionPolicy(input: ExecutionPolicyInput): void {
	const scope = input.agentScope ?? "user";
	if ((scope === "project" || scope === "both") && input.confirmProjectAgents !== false && !input.hasUI) {
		throw new Error("project-local agents require confirmation; non-UI execution must set confirmProjectAgents:false explicitly");
	}
	for (const task of input.tasks ?? []) {
		if (task.authority !== "external_side_effect") continue;
		if (input.riskTolerance !== "high") {
			throw new Error("riskTolerance must be high for authority external_side_effect");
		}
		if (!input.allowExternalSideEffectWithoutConfirmation && !input.hasUI) {
			throw new Error("external_side_effect authority requires human confirmation in UI or explicit bypass");
		}
	}
}
