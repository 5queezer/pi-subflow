import { realpath, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { EvalCase, EvalSet, EvalSetInput, LoadedEvalSet, OptimizerObjectiveWeights, OptimizerScoringPolicy } from "./types.js";

const evalSetTopLevelKeys = ["name", "workflow", "objective", "scoring", "cases"] as const;
const evalSetObjectiveKeys = ["taskScore", "cost", "latency", "instability", "complexity"] as const;
const evalSetScoringKeys = ["minRunsPerCase", "minUtilityDelta", "maxFailureRateRegression"] as const;
const evalSetCaseKeys = ["name", "input", "expectedSections", "jsonSchema"] as const;
const evalSetJsonSchemaKeys = ["required"] as const;

export async function loadEvalSet(input: { evalSet: EvalSetInput; cwd: string }): Promise<LoadedEvalSet> {
	const hasPath = typeof input.evalSet.path === "string";
	const hasInline = input.evalSet.inline !== undefined;
	if (hasPath === hasInline) {
		throw new Error("subflow_optimize requires exactly one of evalSet.path or evalSet.inline");
	}
	if (hasInline) {
		const evalSet = normalizeEvalSet(input.evalSet.inline, "inline eval set");
		return {
			evalSet,
			source: { kind: "inline" },
			persistenceRecommendation: `Save this inline eval set to .pi/subflow/evals/${slug(evalSet.name)}.yaml for reuse and review.`,
		};
	}
	const evalSetPath = input.evalSet.path;
	if (typeof evalSetPath !== "string" || evalSetPath.trim() === "") {
		throw new Error("evalSet.path must be a non-empty string");
	}
	const absolutePath = resolveProjectPath(input.cwd, evalSetPath);
	const realAbsolutePath = await resolveProjectRealPath(input.cwd, absolutePath);
	const source = await readFile(realAbsolutePath, "utf8");
	const document = parseDocument(source, { uniqueKeys: true });
	if (document.errors.length) {
		throw new Error(`invalid eval set YAML: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	const evalSet = normalizeEvalSet(document.toJSON(), `eval set ${input.evalSet.path}`);
	const canonical = isSubpath(join(input.cwd, ".pi", "subflow", "evals"), absolutePath);
	return {
		evalSet,
		source: { kind: "path", path: relative(input.cwd, absolutePath), canonical },
	};
}

function resolveProjectPath(cwd: string, path: string): string {
	if (isAbsolute(path)) throw new Error("evalSet.path must be relative to the project");
	const resolved = resolve(cwd, path);
	if (!isSubpath(cwd, resolved)) {
		throw new Error("evalSet.path must stay inside the project");
	}
	return resolved;
}

async function resolveProjectRealPath(cwd: string, path: string): Promise<string> {
	const realCwd = await realpath(cwd);
	const realEvalSetPath = await realpath(path);
	if (!isSubpath(realCwd, realEvalSetPath)) {
		throw new Error("evalSet.path must stay inside the project");
	}
	return realEvalSetPath;
}

function normalizeEvalSet(value: unknown, context: string): EvalSet {
	if (!isRecord(value)) throw new Error(`${context} must be a mapping`);
	rejectUnknownKeys(value, evalSetTopLevelKeys, `${context}`);
	const name = requiredString(value.name, `${context} name`);
	const objective = normalizeObjective(value.objective, context);
	const scoring = normalizeScoring(value.scoring, context);
	if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error(`${context} cases must be a non-empty array`);
	return {
		name,
		workflow: optionalString(value.workflow, `${context} workflow`),
		objective,
		scoring,
		cases: value.cases.map((item, index) => normalizeCase(item, `${context} cases[${index}]`)),
	};
}

function normalizeObjective(value: unknown, context: string): OptimizerObjectiveWeights {
	if (!isRecord(value)) throw new Error(`${context} objective must be a mapping`);
	rejectUnknownKeys(value, evalSetObjectiveKeys, `${context} objective`);
	return {
		taskScore: requiredNumber(value.taskScore, `${context} objective.taskScore`),
		cost: requiredNumber(value.cost, `${context} objective.cost`),
		latency: requiredNumber(value.latency, `${context} objective.latency`),
		instability: requiredNumber(value.instability, `${context} objective.instability`),
		complexity: requiredNumber(value.complexity, `${context} objective.complexity`),
	};
}

function normalizeScoring(value: unknown, context: string): OptimizerScoringPolicy {
	if (!isRecord(value)) throw new Error(`${context} scoring must be a mapping`);
	rejectUnknownKeys(value, evalSetScoringKeys, `${context} scoring`);
	const minRunsPerCase = requiredInteger(value.minRunsPerCase, `${context} scoring.minRunsPerCase`);
	if (minRunsPerCase < 1) throw new Error(`${context} scoring.minRunsPerCase must be at least 1`);
	const minUtilityDelta = requiredNumber(value.minUtilityDelta, `${context} scoring.minUtilityDelta`);
	if (minUtilityDelta < 0) throw new Error(`${context} scoring.minUtilityDelta must be non-negative`);
	const maxFailureRateRegression = requiredNumber(value.maxFailureRateRegression, `${context} scoring.maxFailureRateRegression`);
	if (maxFailureRateRegression < 0) throw new Error(`${context} scoring.maxFailureRateRegression must be non-negative`);
	return {
		minRunsPerCase,
		minUtilityDelta,
		maxFailureRateRegression,
	};
}

function normalizeCase(value: unknown, context: string): EvalCase {
	if (!isRecord(value)) throw new Error(`${context} must be a mapping`);
	rejectUnknownKeys(value, evalSetCaseKeys, `${context}`);
	return {
		name: requiredString(value.name, `${context} name`),
		input: requiredString(value.input, `${context} input`),
		expectedSections: optionalStringArray(value.expectedSections, `${context} expectedSections`),
		jsonSchema: normalizeJsonSchema(value.jsonSchema, `${context} jsonSchema`),
	};
}

function normalizeJsonSchema(value: unknown, context: string): EvalCase["jsonSchema"] {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${context} must be a mapping`);
	rejectUnknownKeys(value, evalSetJsonSchemaKeys, context);
	return {
		required: optionalStringArray(value.required, `${context} required`),
	};
}

function requiredString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, context: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, context);
}

function requiredNumber(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${context} must be a finite number`);
	return value;
}

function requiredInteger(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${context} must be an integer`);
	return value;
}

function optionalStringArray(value: unknown, context: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new Error(`${context} must be an array of non-empty strings`);
	}
	return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowedKeys: readonly string[], context: string): void {
	const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
	if (unknownKeys.length > 0) {
		throw new Error(`${context} has unknown field(s): ${unknownKeys.join(", ")}`);
	}
}

function isSubpath(parent: string, child: string): boolean {
	const relation = relative(parent, child);
	if (relation === "" || relation === ".") return true;
	return !isAbsolute(relation) && !relation.startsWith("..");
}

function slug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "eval-set";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}


