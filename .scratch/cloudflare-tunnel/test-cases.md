# Cloudflare Tunnel MVP 驗證案例

狀態：測試清單；每一項是否實作、執行成功以實際測試結果為準。

## 目前結果（2026-10-30）

- `npm run typecheck`、`npm run docs:check`、`npm run test:migration`：通過。
- `npm test -- --maxWorkers=2`：64 個測試檔、322 個測試通過。完整測試需在允許 Unix domain socket 的環境執行；sandbox 內既有 shared-MCP 測試會因 `EPERM` 失敗。
- Docker `linux/amd64` image build：通過；本機 container smoke 確認 `/healthz` 回 200、未驗證的 MCP request 回 401，且 named-volume 資料在 container recreate 後保留。
- Compose 設定解析：通過。GitHub Actions run [40995141820](https://github.com/acetaxxxx/taiwan-card-rewards-mcp/actions/runs/40995141820) 的 verify 與 multi-platform image publish 均成功。GHCR package 已設為 Public；使用全新的空白 `DOCKER_CONFIG` 匿名查詢 `ghcr.io/acetaxxxx/taiwan-card-rewards-mcp:sha-fab27089054eb265458800a6e5800236308f66f3` 成功，可讀取 `linux/amd64` 與 `linux/arm64` manifests。
- Cloudflare Access／Tunnel、VPS 及 ChatGPT／Gemini 真實連線尚未部署驗收。

## 自動化：HTTP 認證與使用者隔離

- 有效 Cloudflare application assertion 能建立個人帳本並列出工具；缺少、格式錯誤、偽造簽章、過期、尚未生效、錯誤 issuer／audience、非 application token、空 subject、service token、JWKS 不可用都必須拒絕。
- JWKS key rotation 後能驗證新簽章；不能因 key retrieval 失敗繞過驗證。
- 兩個 subject 可各自新增和讀取資料，不能讀到或修改對方的帳本；同一 subject 不同 request 使用相同帳本。
- 原 Bearer JWT OAuth 模式和 stdio 的啟動、工具與 fail-closed 行為仍然可用；Cloudflare 模式不需要原 OAuth server metadata，origin 上未完成還原 journal 時拒絕啟動。

## 自動化：FileStore 與身份重新綁定

- 同一 process 不允許同一資料目錄有兩個獨立 store instance；HTTP 單 process 模式可在留下 PID 鎖後重新啟動，並保存最後成功寫入的資料。
- 一個帳本多次更新不覆寫已完成的先前更新；不同 tenant 的資料隔離。stdio 原有鎖定行為保持。
- 管理者確認後，重新綁定新 principal 到原 tenant，保留原 owner 及 idempotency 語義；舊 principal 無法再使用該帳本。
- 目標 principal 已有帳本、mapping 衝突、損壞或格式錯誤、無效身份、重複與連續重新綁定等情境依規則拒絕或正確處理，不影響其他 tenant。

## 自動化：備份與還原

- 備份前停下 MCP，成功後保存完整資料目錄並恢復服務；拒絕對運作中的 owner 直接修改資料。
- 預設只保留最近七份工具管理的有效備份；自訂數量可用；備份失敗不刪除舊備份或非工具管理的檔案。
- 全量還原和單一 tenant 還原先保存現況、要求明確目標與確認；單 tenant 完整取代目標帳本且不動其他 tenant，不自動合併。
- 損壞備份、路徑穿越、symlink、目標衝突或操作中斷不能把半成品當成成功；中斷 journal 必須阻止服務啟動，並能由管理者回復。
- 測試備份／還原含 principal mapping 的帳本，以及還原前快照的可用性和完整性。

## 自動化：交付

- Typecheck、build、現有測試及新增測試先於 GHCR publish；workflow 條件涵蓋 feature branch、main 和 tag，PR 不發佈。
- Compose 能解析，image 不包含本機環境或資料，非 root 使用者可讀寫持久 volume，host port 僅綁 loopback；container 重建後資料保留。

## 部署後驗收（需真實環境）

- 實際 VPS、Tunnel 和 Managed OAuth：未授權的 MCP client 得到可用的 OAuth challenge，Google 登入、PKCE、refresh、client 註冊及 redirect allowlist 均成功；測試 SSE 回應與 Host header。
- ChatGPT 和 Gemini 分別完成工具探索、讀取與確認後寫入；兩個 Google 使用者隔離；同一 Google 使用者從兩個 client 取得的 principal 與帳本是否一致。
- 非允許清單使用者被拒絕，直接連 origin 不可繞過驗證；檢查日誌不包含 token 或私人資料。
- 在目標 VPS 架構從 GHCR 拉取 image，模擬更新、強制停止重啟、備份及還原，並實際確認資料與 rollback 可用。
