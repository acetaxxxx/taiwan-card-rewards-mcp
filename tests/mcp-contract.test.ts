import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { describe, expect, it } from "vitest";
import { mcpTools, failClosedErrors } from "../src/index.js";

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

class McpProcessClient {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private pending: Map<string | number, { resolve: (res: JsonRpcResponse) => void; reject: (err: any) => void }> = new Map();
  public stderrOutput = "";

  constructor(dataDir: string) {
    const cliPath = resolve(__dirname, "../dist/cli.js");
    const args = [cliPath, "--data-dir", dataDir, "--user", "test-user"];
    this.proc = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = readline.createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse;
        if (parsed.id !== undefined && this.pending.has(parsed.id)) {
          const handler = this.pending.get(parsed.id)!;
          this.pending.delete(parsed.id);
          handler.resolve(parsed);
        }
      } catch (e) {
        // ignore non-json line
      }
    });

    this.proc.stderr!.on("data", (chunk) => {
      this.stderrOutput += chunk.toString();
    });
  }

  send(request: { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }): Promise<JsonRpcResponse> {
    return new Promise((res, rej) => {
      const id = request.id ?? Math.floor(Math.random() * 1000000);
      const payload = { jsonrpc: "2.0", id, ...request };
      this.pending.set(id, { resolve: res, reject: rej });
      this.proc.stdin!.write(JSON.stringify(payload) + "\n");
    });
  }

  sendRaw(raw: string): Promise<string> {
    return new Promise((res) => {
      const onLine = (line: string) => {
        this.rl.off("line", onLine);
        res(line);
      };
      this.rl.on("line", onLine);
      this.proc.stdin!.write(raw + "\n");
    });
  }

  close(): Promise<void> {
    return new Promise((res) => {
      this.rl.close();
      this.proc.stdin!.end();
      this.proc.on("close", () => res());
    });
  }
}

describe("MCP Contract and Agent Boundary", () => {
  it("exposes all ten approved MCP tools with valid schemas in tools/list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-contract-list-"));
    const client = new McpProcessClient(dir);
    try {
      // 1. initialize
      const initRes = await client.send({ id: 1, method: "initialize" });
      expect(initRes.result).toBeDefined();
      expect(initRes.result.protocolVersion).toBe("2024-11-05");
      expect(initRes.result.serverInfo.name).toBe("taiwan-card-rewards-mcp");
      expect(initRes.result.serverInfo.version).toBe("0.3.1");
      expect(initRes.result.instructions).toContain("single-user durable ledger");
      expect(initRes.result.instructions).toContain("fail-closed");

      // 2. tools/list
      const listRes = await client.send({ id: 2, method: "tools/list" });
      expect(listRes.result).toBeDefined();
      expect(listRes.result.tools).toHaveLength(10);

      const toolNames = listRes.result.tools.map((t: any) => t.name).sort();
      const expectedNames = [
        "calculate_reward",
        "list_cards",
        "rank_cards",
        "recommend",
        "record_transaction",
        "register_card",
        "remaining_caps",
        "get_card_switch_status",
        "upsert_card_switch",
        "upsert_offer",
      ].sort();
      expect(toolNames).toEqual(expectedNames);
      expect(mcpTools).toHaveLength(10);

      // Verify schema properties of all tools
      for (const tool of listRes.result.tools) {
        expect(tool.name).toBeTypeOf("string");
        expect(tool.description).toBeTypeOf("string");
        expect(tool.inputSchema).toBeTypeOf("object");
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles JSON-RPC protocol edge cases (notifications, malformed JSON, unknown methods)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-contract-proto-"));
    const client = new McpProcessClient(dir);
    try {
      // notification should not produce response or crash
      client.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

      // malformed JSON -> -32700 Parse error
      const rawRes = await client.sendRaw("{ malformed json");
      const parsedError = JSON.parse(rawRes);
      expect(parsedError.error.code).toBe(-32700);

      // unknown method -> -32601 Method not found
      const unknownMethodRes = await client.send({ id: 10, method: "unknown/method" });
      expect(unknownMethodRes.error?.code).toBe(-32601);

      // unknown tool name -> TOOL_NOT_FOUND
      const unknownToolRes = await client.send({
        id: 11,
        method: "tools/call",
        params: { name: "non_existent_tool", arguments: {} },
      });
      expect(unknownToolRes.error?.message).toBe("TOOL_NOT_FOUND");
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strictly rejects user_id, path overrides, and sensitive financial fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-contract-security-"));
    const client = new McpProcessClient(dir);
    try {
      // Rejection of unknown field / user_id spoofing
      const spoofRes = await client.send({
        id: 20,
        method: "tools/call",
        params: {
          name: "register_card",
          arguments: {
            card: { id: "c1", issuer: "Bank", productName: "Card" },
            user_id: "other-user",
          },
        },
      });
      expect(spoofRes.error?.message).toBe("UNKNOWN_FIELD");

      // Rejection of PAN / card number in arguments
      const panRes = await client.send({
        id: 21,
        method: "tools/call",
        params: {
          name: "register_card",
          arguments: {
            card: { id: "c1", issuer: "Bank", productName: "Card" },
            cardNumber: "4111111111111111",
          },
        },
      });
      expect(panRes.error?.message).toBe("SENSITIVE_FIELD_FORBIDDEN");

      // Rejection of CVV / OTP / token in nested transaction arguments
      const cvvRes = await client.send({
        id: 22,
        method: "tools/call",
        params: {
          name: "record_transaction",
          arguments: {
            transaction: {
              cardId: "c1",
              kind: "purchase",
              mode: "actual",
              idempotencyKey: "tx-1",
              occurredAt: "2026-08-31T00:00:00Z",
              amount: { amountMinor: 10000, currency: "TWD" },
              cvv: "123",
            },
          },
        },
      });
      expect(cvvRes.error?.message).toBe("SENSITIVE_FIELD_FORBIDDEN");
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes the complete 8-tool end-to-end card rewards lifecycle over stdio JSON-RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-contract-e2e-"));
    const client = new McpProcessClient(dir);
    try {
      // Step 1: register_card
      const cardInput = {
        id: "esun-travel-card",
        issuer: "ESunBank",
        productName: "Kumamon Card",
        network: "JCB",
        country: "TW",
      };
      const regRes = await client.send({
        id: 101,
        method: "tools/call",
        params: { name: "register_card", arguments: { card: cardInput } },
      });
      expect(regRes.result.structuredContent.id).toBe("esun-travel-card");

      // Step 2: list_cards
      const listCardRes = await client.send({
        id: 102,
        method: "tools/call",
        params: { name: "list_cards", arguments: {} },
      });
      expect(listCardRes.result.structuredContent).toHaveLength(1);
      expect(listCardRes.result.structuredContent[0].id).toBe("esun-travel-card");

      // Step 3: upsert_offer (with source provenance + offer confirmation)
      const snapshotInput = {
        id: "snap-kumamon-2026",
        url: "https://official.bank.com/",
        fetchedAt: "2026-08-01T00:00:00Z",
        contentHash: "hash-kumamon-2026",
        parserVersion: "v1",
        verified: true,
        sourceType: "official",
        provenance: {
          sourceUrl: "https://official.bank.com/",
          sourceDescription: "Official Kumamon page",
          submitter: "user",
          submittedAt: "2026-08-01T00:00:00Z",
          contentFingerprint: "fp-12345",
        },
      };
      const ruleInput = {
        id: "rule-kumamon-jp",
        cardId: "esun-travel-card",
        version: "2026-08-01",
        sourceSnapshotId: "snap-kumamon-2026",
        status: "active",
        validFrom: "2026-01-01T00:00:00Z",
        settlementCurrency: "TWD",
        match: { countries: ["JP"] },
        reward: { kind: "percentage", rateBps: 850 },
        cap: {
          kind: "calendar_month",
          cap: { amountMinor: 50000, currency: "TWD" },
          usageKey: "kumamon-jp-cap",
        },
      };
      const confirmationInput = {
        confirmedAt: "2026-08-01T00:00:00Z",
        confirmedBy: "user",
        sourceReference: "https://official.bank.com/",
        offerPeriod: { validFrom: "2026-01-01T00:00:00Z" },
        rewardUnit: "TWD",
        rewardConditionsSummary: "JP country",
        capSummary: "50000 TWD calendar month",
      };

      const upsertRes = await client.send({
        id: 103,
        method: "tools/call",
        params: {
          name: "upsert_offer",
          arguments: {
            snapshot: snapshotInput,
            rule: ruleInput,
            confirmation: confirmationInput,
          },
        },
      });
      expect(upsertRes.result.structuredContent.rule.status).toBe("active");

      // Step 4: calculate_reward (pure calculation)
      const plannedTx = {
        cardId: "esun-travel-card",
        kind: "purchase",
        mode: "planned",
        occurredAt: "2026-08-15T10:00:00Z",
        amount: { amountMinor: 200000, currency: "TWD" },
        country: "JP",
      };
      const calcContext = {
        now: "2026-08-15T12:00:00Z",
        usageByKey: { "kumamon-jp-cap": { amountMinor: 0, currency: "TWD" } },
        sourceSnapshots: { "snap-kumamon-2026": snapshotInput },
      };
      const calcRes = await client.send({
        id: 104,
        method: "tools/call",
        params: {
          name: "calculate_reward",
          arguments: {
            rule: ruleInput,
            transaction: plannedTx,
            context: calcContext,
          },
        },
      });
      expect(calcRes.result.structuredContent.status).toBe("ok");
      expect(calcRes.result.structuredContent.grossReward.amountMinor).toBe(17000);
      expect(calcRes.result.structuredContent.cappedReward.amountMinor).toBe(17000);

      // Step 5: rank_cards (pure ranking)
      const rankRes = await client.send({
        id: 105,
        method: "tools/call",
        params: {
          name: "rank_cards",
          arguments: {
            cards: [cardInput],
            rules: [ruleInput],
            transaction: plannedTx,
            context: calcContext,
          },
        },
      });
      expect(rankRes.result.structuredContent).toHaveLength(1);
      expect(rankRes.result.structuredContent[0].rank).toBe(1);

      // Step 6: recommend (store-backed recommendation without mutating ledger)
      const recRes = await client.send({
        id: 106,
        method: "tools/call",
        params: {
          name: "recommend",
          arguments: { transaction: plannedTx, limit: 5 },
        },
      });
      expect(recRes.result.structuredContent).toHaveLength(1);
      expect(recRes.result.structuredContent[0].cardId).toBe("esun-travel-card");

      // Verify no cap was consumed by planned recommend
      const capBeforeRes = await client.send({
        id: 107,
        method: "tools/call",
          params: { name: "remaining_caps", arguments: { cardId: "esun-travel-card", asOf: "2026-08-15T12:00:00Z" } },
      });
      expect(capBeforeRes.result.structuredContent[0].remaining.amountMinor).toBe(50000);

      // Step 7: record_transaction (actual spend)
      const actualTx = {
        cardId: "esun-travel-card",
        kind: "purchase",
        mode: "actual",
        idempotencyKey: "actual-tx-001",
        occurredAt: "2026-08-15T10:00:00Z",
        amount: { amountMinor: 200000, currency: "TWD" },
        country: "JP",
      };
      const recordRes = await client.send({
        id: 108,
        method: "tools/call",
        params: { name: "record_transaction", arguments: { transaction: actualTx } },
      });
      expect(recordRes.result.structuredContent.status).toBe("ok");
      expect(recordRes.result.structuredContent.cappedReward.amountMinor).toBe(17000);

      // Verify remaining_caps after actual spend
      const capAfterSpend = await client.send({
        id: 109,
        method: "tools/call",
        params: { name: "remaining_caps", arguments: { cardId: "esun-travel-card", asOf: "2026-08-15T12:00:00Z" } },
      });
      expect(capAfterSpend.result.structuredContent[0].remaining.amountMinor).toBe(33000);

      // Step 8: Idempotency verification (same key same payload -> return original)
      const dupRes = await client.send({
        id: 110,
        method: "tools/call",
        params: { name: "record_transaction", arguments: { transaction: actualTx } },
      });
      expect(dupRes.result.structuredContent.cappedReward.amountMinor).toBe(17000);

      // Step 9: Refund transaction (reverses reward and cap consumption)
      const refundTx = {
        cardId: "esun-travel-card",
        kind: "refund",
        mode: "actual",
        idempotencyKey: "refund-tx-001",
        refundOfId: "actual-tx-001",
        occurredAt: "2026-08-16T10:00:00Z",
        amount: { amountMinor: 200000, currency: "TWD" },
      };
      const refundRes = await client.send({
        id: 111,
        method: "tools/call",
        params: { name: "record_transaction", arguments: { transaction: refundTx } },
      });
      expect(refundRes.result.structuredContent.status).toBe("ok");
      expect(refundRes.result.structuredContent.grossReward.amountMinor).toBe(-17000);

      // Verify remaining_caps after refund -> restored to 50000
      const capAfterRefund = await client.send({
        id: 112,
        method: "tools/call",
        params: { name: "remaining_caps", arguments: { cardId: "esun-travel-card", asOf: "2026-08-16T12:00:00Z" } },
      });
      expect(capAfterRefund.result.structuredContent[0].remaining.amountMinor).toBe(50000);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
