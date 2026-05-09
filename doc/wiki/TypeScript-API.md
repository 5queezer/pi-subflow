# TypeScript API

```ts
import { MockSubagentRunner, runDag } from "pi-subflow";

const runner = new MockSubagentRunner({
  scout: async ({ task }) => `found: ${task}`,
  reviewer: async ({ task }) => `verified:\n${task}`,
});

const result = await runDag(
  {
    tasks: [
      { name: "frontend", agent: "scout", task: "Inspect frontend auth" },
      { name: "backend", agent: "scout", task: "Inspect backend auth" },
      {
        name: "verify",
        agent: "reviewer",
        role: "verifier",
        dependsOn: ["frontend", "backend"],
        task: "Synthesize findings",
      },
    ],
  },
  { runner },
);

console.log(result.status, result.output);
```

Primary exports:

- `runSingle`, `runChain`, `runParallel`, `runDag`
- `validateDagTasks`, `planDagStages`
- `discoverAgents`
- `validateExecutionPolicy`
- `appendRunHistory`
- `MockSubagentRunner`, `PiSdkRunner`
- `registerPiSubflowExtension`, `piSubflowExtension`
