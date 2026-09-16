# 11: 更新 Agent Skill 並驗收完整工作流

Status: ready-for-agent

**Blocked by:** 10.

**What to build:** 讓一般與低推理成本 Agent 都能只依 MCP action 完成 ingestion、補件與 recommendation，不複製 schema、不跳步也不假造 completion。

## Definition of done

- [ ] Usage guide、MCP server instructions、Taiwan credit-card skill、low-reasoning playbook 與範例使用同一 canonical workflow vocabulary。
- [ ] Skill 只描述 research priority、flow discipline 與 semantic extraction SOP；欄位 schema 連到 MCP tool contract，不另存一份易漂移副本。
- [ ] Agent 每次只執行 MCP 回傳 action，提交後重新讀取狀態；不自行變更 phase 或宣稱 manifest complete。
- [ ] Ingestion trace 覆蓋 official source、manifest、多 benefit、shared exclusion、ignored leaf、finalize 與 completion proof。
- [ ] Recommendation trace 覆蓋 fast path、merchant ambiguity、FX 補件、benefit refresh handoff、來源失敗停止與 partial delivery。
- [ ] Deterministic public-contract tests 與實際模型 trace 分開記錄；未執行的模型相容性不得宣稱通過。
- [ ] 文件範例 payload 全部通過 public MCP schema，且不包含 credential、PAN、account number、secret 或內部-only 欄位。
- [ ] Typecheck、build、full test suite、migration tests、public MCP E2E 與文件/skill consistency checks 全數通過。
- [ ] Package/README 工具清單、版本說明與發版注意事項反映新增 public surface；本票不執行 release 或 publish。

## Comments

此票是整體完成門檻，不替代各票在實作當下更新相關文件及測試的責任。
