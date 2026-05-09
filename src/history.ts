import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FlowResult } from "./types.js";

export interface RunHistoryEntry extends FlowResult {
	mode: "single" | "chain" | "parallel" | "dag";
	runId?: string;
	createdAt?: string;
}

export async function appendRunHistory(path: string, entry: RunHistoryEntry): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const record = {
		runId: entry.runId ?? randomUUID(),
		createdAt: entry.createdAt ?? new Date().toISOString(),
		mode: entry.mode,
		status: entry.status,
		output: entry.output,
		results: entry.results,
		trace: entry.trace,
	};
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}
