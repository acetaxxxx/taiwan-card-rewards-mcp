import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CardDescriptor, CardSwitchCampaign, CardSwitchEnrollment, CardSwitchProjection, OfferRuleVersion, OfferSourceSnapshot, RewardBreakdown, TransactionTuple } from './types.js';
import type { StartupConfig } from './startup.js';
import { validateStoredState } from './validation.js';

export interface RecordedTransaction {
  transaction: TransactionTuple;
  reward: RewardBreakdown;
}

export interface StoredState {
  schemaVersion: 1;
  cards: CardDescriptor[];
  snapshots: OfferSourceSnapshot[];
  rules: OfferRuleVersion[];
  transactions: RecordedTransaction[];
  campaigns: CardSwitchCampaign[];
  switchEnrollments: CardSwitchEnrollment[];
  cardSwitches: CardSwitchProjection[];
}

export const emptyState = (): StoredState => ({ schemaVersion: 1, cards: [], snapshots: [], rules: [], transactions: [], campaigns: [], switchEnrollments: [], cardSwitches: [] });

export class StoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
  }
}

/** A replaceable persistence boundary for credit-card rewards state. */
export interface LedgerStore {
  read(): StoredState;
  write(next: StoredState): void;
  update(mutator: (state: StoredState) => void): StoredState;
  close(): void;
}

/** A single-process, tenant-bound JSON store. The future sidecar can replace this interface with SQLite. */
export class FileStore implements LedgerStore {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly lockFd: number;
  private state: StoredState;
  private closed = false;

  constructor(config: StartupConfig) {
    this.filePath = path.join(config.dataDir, 'card-rewards.json');
    this.lockPath = path.join(config.dataDir, 'card-rewards.lock');
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      this.lockFd = fd;
    } catch {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve startup error */ } try { fs.unlinkSync(this.lockPath); } catch { /* preserve startup error */ } }
      throw new StoreError('LOCK_EXISTS', 'another MCP process already owns this data directory');
    }
    try {
      this.state = this.load();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.lockFd); } catch { /* already closed */ }
    try { fs.unlinkSync(this.lockPath); } catch { /* preserve process shutdown */ }
  }

  read(): StoredState {
    return structuredClone(this.state);
  }

  write(next: StoredState): void {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    const body = JSON.stringify(next, null, 2) + '\n';
    try {
      fs.writeFileSync(tempPath, body, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
      this.state = structuredClone(next);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve the original error */ }
      throw new StoreError('STORE_UNAVAILABLE', error instanceof Error ? error.message : 'could not persist state');
    }
  }

  update(mutator: (state: StoredState) => void): StoredState {
    const next = this.read();
    mutator(next);
    this.write(next);
    return this.read();
  }

  private load(): StoredState {
    if (!fs.existsSync(this.filePath)) return emptyState();
    try {
      return validateStoredState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      throw new StoreError('STORE_CORRUPT', error instanceof Error ? error.message : 'invalid state file');
    }
  }
}

export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
