# ChatGPT 與 Gemini 遠端 MCP service 研究

研究日期：2026-10-28。以下以 ChatGPT 網頁版、Gemini Apps 網頁版的自訂 MCP 連線為主；Gemini API 另列說明，避免把 API 的功能和消費者網頁版混為一談。

## 摘要

- 兩個網頁產品都已提供連接自訂遠端 MCP server 的方式。
- 共通實作應採用 **Streamable HTTP**。Gemini Connected Apps 明確只支援此 transport，不支援舊式雙端點 HTTP+SSE；OpenAI 的 MCP server 部署文件也以 Streamable HTTP 為正式部署方式。
- 共通部署形態是固定的公開 HTTPS MCP URL，例如 `https://<host>/mcp`。ChatGPT 可用 Secure MCP Tunnel 做私有測試；Gemini Developer Mode 要求可從公開網路連到 HTTPS endpoint。
- 目前 Gemini Apps 自訂 app 的官方資格限制為美國、年滿 18 歲、個人 Google 帳戶、Keep Activity 開啟，而且只支援英文。這是實際連線前需要確認的限制。
- 此 repo 的 MCP process 現在只用 stdio，並以固定 `dataDir` 隔離一個 tenant。HTTP listener 本身不會自動提供登入或 tenant 隔離。

## 產品連線方式

| 產品 | 網頁版自訂 MCP 支援 | Transport / endpoint | 帳戶與使用限制 |
|---|---|---|---|
| ChatGPT | 從 Plugins/Apps 加入自訂 MCP server，連線時掃描 tools。 | 可提供公開 HTTPS MCP URL；正式部署建議 Streamable HTTP 和穩定的 `/mcp` URL。私有開發環境可用 Secure MCP Tunnel。 | 官方說明列出 Business、Enterprise/Edu 可用完整 MCP；Pro 目前限 read/fetch。自訂 MCP 連線為網頁版。 |
| Gemini Apps | 在 Gemini 網頁版的 Connected Apps 加入自訂 app，填入 MCP server URL；建立後也可在 Gemini 手機 app 使用。 | Google Connected Apps 要求公開 HTTPS endpoint、單一 Streamable HTTP endpoint；舊式 HTTP+SSE 不支援。 | 須年滿 18 歲、人在美國、使用個人 Google 帳戶、開啟 Keep Activity；自訂 app 目前只支援英文。建立連線的流程需在網頁版完成。 |

ChatGPT 帳戶方案和連線方式以[官方 custom MCP 說明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)為準。其[server 部署文件](https://developers.openai.com/plugins/build/mcp-server)要求正式 endpoint 使用穩定、公開可連線的 HTTPS URL，並支援 Streamable HTTP；`/mcp` 是常見路徑。私有網路上的 server 可用 Secure MCP Tunnel 供 ChatGPT 連接，但該 tunnel 不等同公開發布 endpoint。

Gemini Apps 的[自訂 app 說明](https://support.google.com/gemini/answer/17209137?hl=en)確認可在 Gemini 網頁版輸入 MCP URL。Google 的[Developer Mode 指引](https://developers.google.com/connected-apps/mcp/dev-mode/usage)要求用公開 HTTPS URL 測試；若使用預先註冊的 OAuth client，可在連線設定輸入 Client ID 和 Client Secret。

## Transport 與協定版本

MCP 的[2025-11-25 transport 規格](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)定義 stdio 與 Streamable HTTP。後者以單一 MCP endpoint 接收 POST，也可選擇用 GET 開啟 server-to-client SSE stream；POST 回應可為 JSON，或在需要串流時使用 SSE。Server 必須檢查 `Origin`，並應對 HTTP 連線實作適當驗證。

Google 的[Connected Apps MCP standards](https://developers.google.com/connected-apps/mcp/server-optimization)明確表示：平台支援到 `2025-11-25` 的 MCP protocol version，Streamable HTTP transport 至少須符合 `2025-03-26`，舊式 HTTP+SSE 不支援。Google 以同一 URL 收到 initialize、`tools/list`、`tools/call` 的 HTTP POST；若 server 不提供獨立 GET SSE stream，可對 GET 回 `405 Method Not Allowed`。

MCP 的[2026-07-28 versioning spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)已新增 modern era：不再使用 `initialize` handshake，而是每個 request 自帶 protocol version，server 提供 `server/discover`；`2025-11-25` 及之前屬於 legacy handshake era。Google 文件目前明確只支援到 `2025-11-25`。OpenAI 的 ChatGPT custom MCP 文件指定 Streamable HTTP，但沒有說明 ChatGPT 網頁 client 使用哪個 MCP protocol revision。因此不能僅從文件確定 ChatGPT 與 Gemini 用相同的 handshake。對 Gemini 的相容目標是 `2025-11-25`；ChatGPT 需實際連線驗證，若使用 `2026-07-28`，可能要讓同一 server endpoint 同時服務兩種 era。

## 身分驗證與個人資料

ChatGPT 的[OAuth 指引](https://developers.openai.com/plugins/build/auth)指出，匿名、唯讀 MCP 可以不驗證；若提供使用者專屬資料或寫入操作，應驗證使用者。已驗證 server 預期使用符合 MCP authorization spec 的 OAuth 2.1。ChatGPT 支援 client metadata、DCR、預先註冊 client 與 PKCE；server 要提供 Protected Resource Metadata、驗證 bearer token 的 issuer/audience/expiry/scope。ChatGPT 不支援 client-credentials 等 machine-to-machine grant，也不能提供自訂 API key 作為 ChatGPT 使用者登入方式。

Gemini 的[OAuth 指引](https://developers.google.com/connected-apps/mcp/oauth)建議 OAuth 2.1 authorization-code flow 與 PKCE；支援 Dynamic Client Registration 時可自動註冊，否則需預先註冊 OAuth client，並在設定中輸入 client credentials。Gemini 和 ChatGPT 的 OAuth redirect URI 不同，OAuth provider 需分別允許各 client 的 redirect URI。

共通設計應把 MCP server 當作 OAuth resource server：驗證每次 HTTP request 的 token，並從已驗證的主體決定可存取的資料。MCP [authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)要求 Protected Resource Metadata 與 authorization server discovery；token 由 authorization server 簽發，MCP server 負責驗證。只用匿名 endpoint 或單一長效 bearer token，不足以代表 ChatGPT 使用者，也無法建立可稽核的使用者授權。

## Gemini API 與 Gemini Apps 的差別

Gemini API 另有 Remote MCP tool，在 Interactions API request 中指定 MCP server name 和 URL；Google AI API 文件也明確說 Remote MCP 只支援 Streamable HTTP、不支援 SSE，並可傳送 HTTP headers 和 `allowed_tools`。這是程式透過 Gemini API 呼叫模型的功能，與使用者直接在 `gemini.google.com` 設定 Connected App 是兩條不同的接入流程。[Gemini API Remote MCP 文件](https://ai.google.dev/gemini-api/docs/function-calling#remote-mcp)

## 對本 repo 的影響

- 現有 [CLI](../../src/cli.ts) 直接從 stdin 讀 JSON-RPC、往 stdout 寫回應；[initialize 結果](../../src/cli.ts)目前宣告 `2024-11-05`。這是 stdio 入口，不能只把 stdin/stdout 包在一般 HTTP handler 外面就當成 Streamable HTTP。
- [Startup contract](../../src/startup.ts)將 canonical `dataDir` 定義為唯一 tenant 邊界；`--user` 只供顯示/稽核，不能當授權或 storage selector。Storage 會對同一個 data directory 加 exclusive lock。公開 HTTP service 必須把驗證出的使用者身分固定映射到隔離的資料目錄，或明確只部署一個 owner 的目錄。
- Google 文件提醒 Connected Apps 在註冊時會 snapshot tool schemas，改 schema 要同步或發新版本；文件也建議精簡 tools，暴露數十個 tools 或過度巢狀的 mega-tool 可能被要求調整。目前 repo 有 28 個 canonical tools，正式連 Gemini 前應確認完整暴露是否合適。[Google MCP standards](https://developers.google.com/connected-apps/mcp/server-optimization)
- ChatGPT 也以已核准的 tool snapshot 為準；server 後續改變工具定義時，管理者需要 refresh/publish 才會更新。[ChatGPT custom MCP 說明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- 使用者已選擇多使用者 service。OAuth 身分必須由 server 驗證，並將 `(issuer, subject)` 映射到各自的 tenant store；不同登入憑證本身不會隔離共用的 `dataDir`。

## 實作起點

若目標是同時連 ChatGPT 網頁版和 Gemini Apps，Streamable HTTP、穩定公開 HTTPS `/mcp` endpoint、OAuth 2.1 authorization-code + PKCE 是共同方向。協定 revision 要先用 Gemini 的 `2025-11-25` 相容要求和 ChatGPT 實際初始化 request 做驗證，再決定只服務 legacy handshake 或同一 endpoint 同時支援 modern/legacy。先用 Gemini Developer Mode 與 ChatGPT custom MCP connection 做實際連線測試，再選擇是否需要 Google Connected Console 發布流程。Hosting provider、OAuth provider、單人/多人 tenant 模式仍需在 spec 中定案。

## 主要官方來源

- [ChatGPT: Connecting custom MCP servers](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [OpenAI Developers: Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI Developers: Authentication for MCP servers](https://developers.openai.com/plugins/build/auth)
- [Gemini Apps Help: Connect custom MCP apps](https://support.google.com/gemini/answer/17209137?hl=en)
- [Google Developers: Gemini Apps Developer Mode](https://developers.google.com/connected-apps/mcp/dev-mode/usage)
- [Google Developers: Connected Apps MCP standards](https://developers.google.com/connected-apps/mcp/server-optimization)
- [Google Developers: Connected Apps OAuth 2.1](https://developers.google.com/connected-apps/mcp/oauth)
- [Google AI for Developers: Remote MCP in the Gemini API](https://ai.google.dev/gemini-api/docs/function-calling#remote-mcp)
- [MCP Specification 2025-11-25: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Specification 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
