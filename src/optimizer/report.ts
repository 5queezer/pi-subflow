import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CandidateEvaluation, OptimizerReport } from "./types.js";

export function formatOptimizerReport(report: OptimizerReport): string {
	const lines = [
		`subflow_optimize dry-run report: ${report.evalSetName}`,
		`Report ID: ${report.reportId}`,
		`Baseline: ${formatCandidate(report.baseline)}`,
	];
	if (report.candidates.length) {
		lines.push("Candidates:");
		for (const candidate of report.candidates) lines.push(`- ${formatCandidate(candidate)}`);
	} else {
		lines.push("Candidates: none supplied");
	}
	lines.push(`Recommendation: ${report.recommendation}`);
	if (report.warnings.length) {
		lines.push("Warnings:");
		for (const warning of report.warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

export async function writeOptimizerReport(cwd: string, report: OptimizerReport): Promise<string> {
	if (!/^[A-Za-z0-9._-]+$/u.test(report.reportId)) throw new Error("reportId must be a safe filename");
	const dir = resolve(cwd, ".pi", "subflow", "optimizer-reports");
	await mkdir(dir, { recursive: true });
	const realCwd = await realpath(cwd);
	const realDir = await realpath(dir);
	if (!isSubpath(realCwd, realDir)) throw new Error("optimizer report directory must stay inside the project");
	const path = resolve(realDir, `${report.reportId}.json`);
	if (!isSubpath(realDir, path)) throw new Error("optimizer report path must stay inside .pi/subflow/optimizer-reports");
	await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
	return path;
}

function isSubpath(parent: string, child: string): boolean {
	const relation = relative(parent, child);
	if (relation === "" || relation === ".") return true;
	return !isAbsolute(relation) && !relation.startsWith("..");
}

function formatCandidate(candidate: CandidateEvaluation): string {
	if (candidate.status === "invalid") return `${candidate.label} invalid (${candidate.error ?? "unknown error"})`;
	const utility = candidate.utility === undefined ? "n/a" : candidate.utility.toFixed(4);
	const runs = candidate.metrics?.runs ?? 0;
	const failures = candidate.metrics?.failures ?? 0;
	return `${candidate.label} ${candidate.status}, utility=${utility}, runs=${runs}, failures=${failures}`;
}
