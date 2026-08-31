# data/

Committed build artifacts the runner needs at run time.

## `cutoff-quiz.json`

The frozen quiz bank behind the knowledge-cutoff probe. Not hand-written:
build it with `pnpm cutoff:build`, skim it, then commit it.

It has to be committed rather than regenerated per run, for the same reason
`src/briefs.ts` is frozen — every model must answer the *same* questions or
the curves aren't comparable. Appending new months at the tail is fine and
leaves older buckets byte-identical; editing or dropping existing items
invalidates every published curve, so bump `version` and publish a new file
instead.

See the [Knowledge cutoff](../README.md#knowledge-cutoff) section for the
method and the rebuild workflow.
