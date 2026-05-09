## Files Retrieved

1. `src/index.ts` (lines 1-27) - Main entry point, exports all public types and functions from the subagent framework.
2. `src/types.ts` (lines 1-79) - Core TypeScript interfaces and types for subagent tasks, runners, flows, and execution options.
3. `src/runner.ts` (lines 1-239) - Implementation of different subagent runners (Mock, PiSdk, PiSubprocess) and helper functions for executing subagents.
4. `src/agents.ts` (lines 1-97) - Agent discovery and definition loading from markdown files with frontmatter.

## Key Code

```typescript
// From src/types.ts
export interface SubagentTask {
 name?: string;
 agent: string;
 task: string;
 cwd?: string;
 dependsOn?: string[];
 role?: TaskRole;
 authority?: "read_only" | "internal_mutation" | "external_side_effect";
 tools?: string[];
 model?: string;
 thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
 expectedSections?: string[];
 jsonSchema?: { required?: string[] };
}

export interface RunnerInput extends SubagentTask {
 name: string;
}

export interface SubagentRunner {
 run(input: RunnerInput, signal?: AbortSignal): Promise<SubagentResult>;
}
```

```typescript
// From src/runner.ts - key runner classes
export class PiSdkRunner implements SubagentRunner { /* ... */ }
export class PiSubprocessRunner implements SubagentRunner { /* ... */ }
```

## Architecture

Pi-subflow is a framework for building and orchestrating subagents. The core concepts:

- **AgentDefinition**: Describes an agent's capabilities (name, description, tools, model, thinking, instructions).
- **SubagentTask**: A unit of work assigned to an agent, including dependencies and execution parameters.
- **SubagentRunner**: Responsible for executing a task via different backends (SDK, subprocess, mock).
- **Flows**: Patterns for combining tasks (single, chain, parallel, DAG) implemented in src/flows/.
- **Discovery**: Automatically loads agent definitions from markdown files in user/project directories.

## Start Here

Begin with `src/index.ts` to understand the public API, then examine `src/types.ts` for core data structures, and finally `src/runner.ts` to see how tasks are executed.
