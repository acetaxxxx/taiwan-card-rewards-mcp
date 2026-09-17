# 11: 更新 Agent Skill 並驗收完整工作流

Status: completed

**Blocked by:** 10.

**What to build:** 讓一般與低推理成本 Agent 都能只依 MCP action 完成 ingestion、補件與 recommendation，不複製 schema、不跳步也不假造 completion。

## Definition of done

- [x] 更新 `docs/taiwan-card-rewards-skill/` 的 base skill、evidence skill、相關 onboarding/research workflow、recommendation skill 及 low-reasoning playbook，使其使用同一 canonical workflow vocabulary。
- [x] Skill 只描述 research priority、flow discipline 與 semantic extraction SOP；欄位 schema 連到 MCP tool contract，不另存一份易漂移副本。
- [x] Agent 每次只執行 MCP 回傳 action，提交後重新讀取狀態；不自行變更 phase 或宣稱 manifest complete。
- [x] Skill 指引 Agent 遇到既有 source-scope draft 時恢復既有 flow；遇到 `expired` 時建立新 revision，而不是重送過期 action 或另開重複 draft。
- [x] Ingestion trace 覆蓋 official source、manifest、多 benefit、shared exclusion、ignored leaf、finalize 與 completion proof。
- [x] Recommendation trace 覆蓋 fast path、merchant ambiguity、FX 補件、benefit refresh handoff、來源失敗停止與 partial delivery。
- [x] Deterministic public-contract tests 與實際模型 trace 分開記錄；未執行的模型相容性不得宣稱通過。
- [x] 文件範例 payload 全部通過 public MCP schema，且不包含 credential、PAN、account number、secret 或內部-only 欄位。
- [x] Typecheck、build、full test suite、migration tests、public MCP E2E 與文件/skill consistency checks 全數通過。migration coverage 以 `npm run test:migration` 執行，驗證 FileStore 從 schema v2/v3 升級至 v4。
- [x] Package/README 工具清單、版本說明與發版注意事項反映新增 public surface；本票不執行 release 或 publish。

## Comments

此票是整體完成門檻，不替代各票在實作當下更新相關文件及測試的責任。

## Evidence and Audit Notes

- **DoD 1-8:** Proven by `docs/taiwan-card-rewards-skill/`, `docs/usage/ai-agent-usage-guide.md`, MCP tools contract in `src/mcp-contract.ts`, and public workflow traces in `docs/traces/`.
- **DoD 9 (Verification & Migration):** Proven by running `npm run typecheck`, `npm run build`, `npm run docs:check`, `npm test`, and `npm run test:migration`. The `test:migration` script executes `vitest run tests/persistence.test.ts`, directly verifying transparent on-load schema upgrade from schemaVersion 2 and 3 fixtures up to schemaVersion 4.
- **DoD 10 (Public surface documentation):** Documented in `README.md`, `package.json`, and tool catalog docs. No release/publish executed.

