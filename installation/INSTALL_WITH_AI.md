# Install Taiwan Card Rewards MCP with an AI agent

This page is a copyable instruction for an AI coding agent. It installs the
MCP server configuration and the complete runtime skill bundle without mixing
them with this repository's contributor instructions.

Before pasting the instruction, replace these placeholders:

- `<MCP_CONFIG_FILE>`: the MCP configuration file managed by your AI host.
- `<SKILL_DIRECTORY>`: the directory where that host discovers user skills.
- `<DATA_DIR>`: an absolute, private directory for this user's card-rewards data.

Use a different `<DATA_DIR>` for every user or environment. The directory is
the storage and tenant boundary.

## Copy this instruction into your AI agent

```text
Install taiwan-card-rewards-mcp and its runtime skill for me.

Inputs:
- MCP config file: <MCP_CONFIG_FILE>
- Skill directory: <SKILL_DIRECTORY>
- Private data directory: <DATA_DIR>
- Pinned release: v0.14.0

Complete these steps:

1. Inspect the three supplied paths. Ask me only if a path is missing,
   relative where an absolute path is required, or unsafe to modify. Preserve
   unrelated configuration and existing user files.
2. Create the private data directory with permissions limited to the current
   user. Never place it inside the installed skill or a shared repository.
3. Add this stdio MCP server to the supplied MCP config, merging with existing
   servers instead of replacing them:

   {
     "mcpServers": {
       "taiwan_card_rewards_mcp": {
         "command": "npx",
         "args": [
           "--yes",
           "github:acetaxxxx/taiwan-card-rewards-mcp#v0.14.0",
           "--data-dir",
           "<DATA_DIR>"
         ]
       }
     }
   }

4. Obtain the same pinned release and copy the complete directory
   `docs/taiwan-card-rewards-skill/` into
   `<SKILL_DIRECTORY>/taiwan-card-rewards/`. Register the base router at
   `taiwan-card-rewards/SKILL.md` and its three task skill folders:
   `card-rewards-recommendation`,
   `card-rewards-evidence`, and `card-rewards-ledger`. Preserve the complete
   bundle structure; do not copy a single SKILL.md or install the repository's
   AGENTS.md as a user skill.
5. Validate every installed SKILL.md frontmatter and its relative Markdown
   links. Confirm that `references/mcp-tools.md` and
   `references/low-reasoning-playbook.md` are present.
6. Tell me whether the host must be restarted or its MCP/skills reloaded. Do
   not claim the installation is active until reload has happened.
7. After reload, initialize the MCP server, confirm
   `serverInfo.name = taiwan_card_rewards_mcp`, confirm version 0.16.0, and
   confirm tools/list exposes the complete 28-tool contract including
   `recommend`, `list_transactions`, and ingestion tools.
8. Run a read-only smoke check with list_cards. Do not create cards, offers,
   routes, transactions, or benefit records during installation.
9. Report the files changed, installed skill path, data directory, handshake
   result, tool count, and any action I still need to perform.

Safety boundaries:
- Never request, read, store, or forward PAN, CVV/CVC, OTP, passwords,
  cookies, tokens, bank credentials, account numbers, or API keys.
- The MCP has no outbound network access. External offer, PDF, image, OCR, and
  FX research belongs to the AI agent or UI after installation.
- Stop and explain the exact blocker if config edits, installation, reload, or
  validation cannot be completed. Do not silently install an unpinned version
  or invent a fallback calculator or data store.
```

## What gets installed

- The MCP entry config starts the pinned package through `npx` and binds it to
  one absolute data directory.
- The runtime skill teaches a user-facing agent how to research offers, call
  the MCP, interpret fail-closed results, and protect sensitive data.
- Root [`AGENTS.md`](../AGENTS.md) remains contributor-only guidance for agents
  developing this repository. It is not part of the user installation.
