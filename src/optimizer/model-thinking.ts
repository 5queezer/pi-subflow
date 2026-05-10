import type { SubagentTask } from "../types.js";

export const modelTiers = {
	mini: "openai-codex/gpt-5.4-mini",
	strong: "openai-codex/gpt-5.5",
} as const;

export const defaultVerifierModel = modelTiers.strong;
export const defaultVerifierThinking = "medium" satisfies NonNullable<SubagentTask["thinking"]>;

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ThinkingLevel = typeof thinkingLevels[number];

type ModelThinkingConfig = {
	model: string;
	thinking: ThinkingLevel;
};

export type ModelThinkingVariant = ModelThinkingConfig & {
	description: string;
};

export function baselineModelThinking(task: SubagentTask): ModelThinkingConfig {
	return {
		model: task.model ?? defaultVerifierModel,
		thinking: task.thinking ?? defaultVerifierThinking,
	};
}

export function modelThinkingVariants(task: SubagentTask, count: number): ModelThinkingVariant[] {
	if (count <= 0) return [];
	const baseline = baselineModelThinking(task);
	const switchedModel = switchModelTier(baseline.model);
	const lowerThinking = adjacentThinking(baseline.thinking, -1);
	const higherThinking = adjacentThinking(baseline.thinking, 1);
	const candidates: ModelThinkingVariant[] = [
		{ model: switchedModel, thinking: baseline.thinking, description: "switch model tier" },
		{ model: baseline.model, thinking: lowerThinking, description: "lower thinking one step" },
		{ model: baseline.model, thinking: higherThinking, description: "raise thinking one step" },
		{ model: switchedModel, thinking: lowerThinking, description: "switch model tier and lower thinking one step" },
		{ model: switchedModel, thinking: higherThinking, description: "switch model tier and raise thinking one step" },
	];

	const seen = new Set<string>([keyOf(baseline)]);
	const variants: ModelThinkingVariant[] = [];
	for (const candidate of candidates) {
		const key = keyOf(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		variants.push(candidate);
		if (variants.length >= count) break;
	}
	return variants;
}

function switchModelTier(model: string): string {
	if (model === modelTiers.mini) return modelTiers.strong;
	return modelTiers.mini;
}

function adjacentThinking(thinking: ThinkingLevel, offset: -1 | 1): ThinkingLevel {
	const index = thinkingLevels.indexOf(thinking);
	const nextIndex = Math.min(thinkingLevels.length - 1, Math.max(0, index + offset));
	return thinkingLevels[nextIndex] ?? thinking;
}

function keyOf(config: ModelThinkingConfig): string {
	return `${config.model}\u0000${config.thinking}`;
}
