# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Triage state is recorded as a `Status:` line near the top of each issue file.
- Comments and conversation history append to the bottom under `## Comments`.

## Publishing

When a skill says to publish to the issue tracker, create the requested Markdown file under `.scratch/<feature-slug>/`.

## Closing and archiving

Keep `.scratch/` only for work that is active, awaiting triage, or still needed
to explain an unresolved decision. Before treating a feature directory as
complete, make its spec and every issue agree on the terminal status and either
check every acceptance item or record why it was superseded.

After the durable outcome has been recorded in source, tests, ADRs, or user
documentation, move a completed feature directory to `docs/archive/issues/`
and update any links. Do not archive a directory with `needs-triage`,
`ready-for-agent`, `ready-for-human`, unchecked acceptance items, or references
to an unresolved contract.
