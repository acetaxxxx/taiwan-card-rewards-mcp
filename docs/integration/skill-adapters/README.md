# Skill adapter integration

This directory is for people adapting the canonical runtime skill to a host
that needs its own prompt, wrapper, or configuration format. It is not copied
into a user's skill directory.

- [Authoring guide](authoring-guide.md) explains the adapter seam and the
  MCP-owned calculation and persistence invariants.
- [Skill template](skill-template.md) is a starting point for a local adapter.
- [Architecture and boundaries](architecture-and-boundaries.md) defines the
  Agent Workspace/MCP division of responsibility.
- [Adapter manifest](adapter-manifest.json) is the metadata template for a
  derived adapter.

The only distributable runtime skill is
[`docs/taiwan-card-rewards-skill/`](../../taiwan-card-rewards-skill/).
