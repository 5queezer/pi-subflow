# Troubleshooting

### Pi still shows old DAG validation errors

If invalid DAGs return a generic error such as:

```text
dependency cycle or unknown dependency among: ...
```

Pi may be loading an older extension implementation. Check for conflicts:

```bash
ls -la ~/.pi/agent/extensions
readlink -f ~/.pi/agent/extensions/subflow
```

The local development symlink should point to:

```text
/home/christian/Projects/pi-subflow/dist
```

Rebuild and reload:

```bash
npm run build
# then run /reload inside Pi
```

### Invalid role errors

Only these task roles are valid:

```text
worker, verifier
```

Omit `role` for normal worker tasks. Do not use invented roles such as `researcher`.

### Verifier did not receive dependency outputs

Dependency outputs are injected for verifier tasks. Set:

```json
{ "role": "verifier" }
```

on synthesis, judge, or validation nodes that need dependency context.
