import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
	const realCwd = await realpath(cwd);
	const piDir = resolve(cwd, ".pi");
	await mkdir(piDir, { recursive: true });
	const realPiDir = await realpath(piDir);
	if (!isSubpath(realCwd, realPiDir)) throw new Error("optimizer report directory must stay inside the project");
	const subflowDir = resolve(realPiDir, "subflow");
	await mkdir(subflowDir, { recursive: true });
	const realSubflowDir = await realpath(subflowDir);
	if (!isSubpath(realCwd, realSubflowDir)) throw new Error("optimizer report directory must stay inside the project");
	const reportDir = resolve(realSubflowDir, "optimizer-reports");
	await mkdir(reportDir, { recursive: true });
	const realDir = await realpath(reportDir);
	if (!isSubpath(realCwd, realDir)) throw new Error("optimizer report directory must stay inside the project");
	const path = resolve(realDir, `${report.reportId}.json`);
	if (!isSubpath(realDir, path) || dirname(path) !== realDir) throw new Error("optimizer report path must stay inside .pi/subflow/optimizer-reports");
	await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
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
	const trainUtility = candidate.trainUtility === undefined ? "n/a" : candidate.trainUtility.toFixed(4);
	const holdoutUtility = candidate.holdoutUtility === undefined ? "n/a" : candidate.holdoutUtility.toFixed(4);
	const runs = candidate.metrics?.runs ?? 0;
	const failures = candidate.metrics?.failures ?? 0;
	const quality = candidate.metrics?.qualityAssessedRuns ?? 0;
	const profile = candidate.metrics?.profileOnly ? ", profile-only" : "";
	return `${candidate.label} ${candidate.status}, utility=${utility}, train=${trainUtility}, holdout=${holdoutUtility}, runs=${runs}, failures=${failures}, qualityRuns=${quality}${profile}`;
}
