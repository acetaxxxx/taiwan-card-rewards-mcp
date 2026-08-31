import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StartupConfig {
  /** Canonical absolute directory and the sole tenant boundary. */
  dataDir: string;
  /** Display/metadata only; never an authorization or storage selector. */
  user?: string;
}

export class StartupContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StartupContractError';
  }
}

function canonicalDataDir(raw: string): string {
  if (!raw || !path.isAbsolute(raw)) throw new StartupContractError('INVALID_DATA_DIR', '--data-dir must be an absolute path');
  let canonical: string;
  try {
    canonical = fs.realpathSync(raw);
  } catch {
    throw new StartupContractError('INVALID_DATA_DIR', '--data-dir must exist and be readable');
  }
  try {
    if (!fs.statSync(canonical).isDirectory()) throw new StartupContractError('INVALID_DATA_DIR', '--data-dir must be a directory');
  } catch (error) {
    if (error instanceof StartupContractError) throw error;
    throw new StartupContractError('INVALID_DATA_DIR', '--data-dir must be readable');
  }
  const isRoot = path.parse(canonical).root === canonical || path.win32.parse(canonical).root === canonical;
  if (isRoot) throw new StartupContractError('DANGEROUS_DATA_DIR', 'a filesystem root cannot be a tenant directory');
  return canonical;
}

/** Parse the only supported startup selectors. Unknown flags are rejected. */
export function parseStartupArgs(argv: readonly string[]): StartupConfig {
  let dataDir: string | undefined;
  let user: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--data-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new StartupContractError('MISSING_DATA_DIR', '--data-dir requires a value');
      dataDir = value;
      index += 1;
    } else if (flag === '--user') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new StartupContractError('INVALID_USER', '--user requires a value');
      user = value;
      index += 1;
    } else {
      throw new StartupContractError('UNKNOWN_ARGUMENT', `unsupported startup argument: ${flag}`);
    }
  }
  if (!dataDir) throw new StartupContractError('MISSING_DATA_DIR', '--data-dir is required');
  return { dataDir: canonicalDataDir(dataDir), ...(user ? { user } : {}) };
}

/** Tool calls must use this startup-bound directory; arbitrary paths are forbidden. */
export function assertToolDataDir(config: StartupConfig, requested?: string): void {
  if (requested !== undefined && requested !== config.dataDir) {
    throw new StartupContractError('DATA_DIR_OVERRIDE_FORBIDDEN', 'tools cannot override the startup data directory');
  }
}
