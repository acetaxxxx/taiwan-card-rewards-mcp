# 06: 驗證 shared exclusion 與作用域

Status: ready-for-agent

**Blocked by:** 04.

**What to build:** 將來源共同排除條款建模為第一級 leaf，並以明確依賴及 scope 套用到受影響 benefits。

## Definition of done

- [x] Exclusion leaf 明確保存 type、target、scope、evidence 與受影響 benefit IDs 或 source scope。
- [x] 支援 merchant、transaction category/fact、payment route/method 等既有 evaluator 可表達的 exclusion；無法表達者回 needs_review，不降級成純文字有效規則。
- [x] Benefit dependency closure 能解析 shared exclusions；缺少、循環、互相衝突或 scope ambiguous 時禁止 finalize。
- [x] Local exclusion 與 shared exclusion 不重複套用或互相覆蓋；每個排除可追溯原 leaf 和 evidence。
- [x] `ignored` exclusion 要求理由，且 coverage/completion proof 會顯示它未 materialize。
- [x] Exclusion materialization 只建立 candidate artifacts，不改變 active rules。
- [x] Evaluator 回傳 matched exclusion 與來源，可讓 recommendation 解釋 why-not。
- [x] 測試涵蓋單一 benefit、全來源、部分 benefits、未知 target、矛盾 scope 與共同排除的多 benefit source。
