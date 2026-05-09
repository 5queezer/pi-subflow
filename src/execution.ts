import type { ExecutionOptions, RunnerInput, SubagentResult, SubagentTask, TraceEvent, UsageStats } from "./types.js";
import { validateOutput } from "./validation.js";

export function namedTask(task: SubagentTask, index = 0): RunnerInput {
	return { ...task, name: task.name ?? `${task.agent}-${index + 1}` };
}

export async function runTask(task: RunnerInput, options: ExecutionOptions, trace: TraceEvent[]): Promise<SubagentResult> {
	trace.push({ type: "task_start", name: task.name, timestamp: Date.now() });
	const maxAttempts = retryAttempts(task, options.maxRetries ?? 1);
	let lastError = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptController = new AbortController();
		const abortAttempt = () => attemptController.abort();
		if (options.signal?.aborted) attemptController.abort();
		else options.signal?.addEventListener("abort", abortAttempt, { once: true });
		try {
			const result = await withTimeout(options.runner.run(task, attemptController.signal), options.timeoutSeconds, task.name, () => attemptController.abort());
			const withMetadata = { ...result, role: result.role ?? task.role, model: result.model ?? task.model };
			const normalized = withMetadata.status === "failed" ? withMetadata : { ...withMetadata, status: "completed" as const };
			if (normalized.status === "completed" && (task.expectedSections || task.jsonSchema)) {
				validateOutput(normalized.output, task);
			}
			trace.push({ type: normalized.status === "completed" ? "task_complete" : "task_failed", name: task.name, error: normalized.error, timestamp: Date.now() });
			return normalized;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		} finally {
			options.signal?.removeEventListener("abort", abortAttempt);
		}
	}
	trace.push({ type: "task_failed", name: task.name, error: lastError, timestamp: Date.now() });
	return { name: task.name, agent: task.agent, task: task.task, role: task.role, model: task.model, status: "failed", output: "", error: lastError, usage: {} };
}

export async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const limit = Math.max(1, Math.min(concurrency, items.length || 1));
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

function retryAttempts(task: RunnerInput, requestedAttempts: number): number {
	if (task.authority === "internal_mutation" || task.authority === "external_side_effect") return 1;
	return Math.max(1, requestedAttempts);
}

export function aggregateStatus(results: SubagentResult[]): "completed" | "failed" {
	return results.every((result) => result.status === "completed") ? "completed" : "failed";
}

export function usageTotals(results: SubagentResult[]): Required<UsageStats> {
	return results.reduce(
		(acc, result) => {
			acc.input += result.usage.input ?? 0;
			acc.output += result.usage.output ?? 0;
			acc.cacheRead += result.usage.cacheRead ?? 0;
			acc.cacheWrite += result.usage.cacheWrite ?? 0;
			acc.cost += result.usage.cost ?? 0;
			acc.turns += result.usage.turns ?? 0;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	);
}

export function enforceBudget(results: SubagentResult[], options: ExecutionOptions): void {
	const totals = usageTotals(results);
	const tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	if (options.maxCost !== undefined && totals.cost > options.maxCost) throw new Error(`cost ${totals.cost} exceeds maxCost ${options.maxCost}`);
	if (options.maxTokens !== undefined && tokens > options.maxTokens) throw new Error(`tokens ${tokens} exceeds maxTokens ${options.maxTokens}`);
	if (options.maxTurns !== undefined && totals.turns > options.maxTurns) throw new Error(`turns ${totals.turns} exceeds maxTurns ${options.maxTurns}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutSeconds: number | undefined, name: string, onTimeout?: () => void): Promise<T> {
	if (!timeoutSeconds || timeoutSeconds <= 0) return promise;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`task ${name} timed out after ${timeoutSeconds}s`));
		}, timeoutSeconds * 1000);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}
