import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	body: string;
	path: string;
	source: "user" | "project";
}

export interface DiscoverAgentsOptions {
	userDir?: string;
	projectDir?: string;
	scope?: AgentScope;
}

export async function discoverAgents(options: DiscoverAgentsOptions = {}): Promise<Map<string, AgentDefinition>> {
	const scope = options.scope ?? "user";
	const agents = new Map<string, AgentDefinition>();
	if ((scope === "user" || scope === "both") && options.userDir) {
		await loadAgentsFromDir(options.userDir, "user", agents);
	}
	if ((scope === "project" || scope === "both") && options.projectDir) {
		await loadAgentsFromDir(options.projectDir, "project", agents);
	}
	return agents;
}

async function loadAgentsFromDir(dir: string, source: "user" | "project", agents: Map<string, AgentDefinition>): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries.filter((name) => name.endsWith(".md"))) {
		const path = join(dir, entry);
		try {
			const text = await readFile(path, "utf8");
			const parsed = parseAgentMarkdown(text);
			if (!parsed?.name || !parsed.description) continue;
			agents.set(parsed.name, { ...parsed, path, source });
		} catch {
			// Match Pi's forgiving discovery behavior: skip unreadable or malformed files.
		}
	}
}

function parseAgentMarkdown(text: string): Omit<AgentDefinition, "path" | "source"> | undefined {
	const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return undefined;
	const frontmatter = parseFrontmatter(match[1]);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: Array.isArray(frontmatter.tools) ? frontmatter.tools.map(String) : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		body: match[2],
	};
}

function parseFrontmatter(value: string): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	const lines = value.replaceAll("\r\n", "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const index = line.indexOf(":");
		if (index === -1 || line.trimStart().startsWith("#")) continue;
		const key = line.slice(0, index).trim();
		const raw = line.slice(index + 1).trim();
		if (raw === "") {
			const items: string[] = [];
			while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
				i += 1;
				items.push(unquote(lines[i].replace(/^\s*-\s+/, "").trim()));
			}
			output[key] = items;
		} else if (raw.startsWith("[") && raw.endsWith("]")) {
			output[key] = raw.slice(1, -1).split(",").map((item) => unquote(item.trim())).filter(Boolean);
		} else {
			output[key] = unquote(raw);
		}
	}
	return output;
}

function unquote(value: string): string {
	return value.replace(/^[\'\"]|[\'\"]$/g, "");
}
