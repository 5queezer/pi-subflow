export class OutputValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutputValidationError";
	}
}

export function validateOutput(output: string, contract: { expectedSections?: string[]; jsonSchema?: { required?: string[] } }): void {
	for (const section of contract.expectedSections ?? []) {
		const re = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "im");
		if (!re.test(output)) throw new OutputValidationError(`missing expected section: ${section}`);
	}
	if (contract.jsonSchema) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(output);
		} catch (error) {
			throw new OutputValidationError(`invalid JSON output: ${error instanceof Error ? error.message : "parse failed"}`);
		}
		for (const field of contract.jsonSchema.required ?? []) {
			if (!parsed || typeof parsed !== "object" || !(field in parsed)) {
				throw new OutputValidationError(`missing required JSON field: ${field}`);
			}
		}
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
