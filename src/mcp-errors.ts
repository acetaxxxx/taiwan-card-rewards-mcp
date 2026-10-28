import { RewardServiceError } from './errors.js';
import { ProjectionInputError, ProjectionTooLargeError } from './projections.js';
import { StartupContractError } from './startup.js';

export function getMcpErrorData(error: unknown): { code: string; details?: unknown } {
  const code = error instanceof RewardServiceError || error instanceof StartupContractError || error instanceof ProjectionInputError
    ? error.code
    : error instanceof ProjectionTooLargeError
      ? 'PAYLOAD_TOO_LARGE'
      : 'INTERNAL_ERROR';
  return error instanceof RewardServiceError && error.details !== undefined ? { code, details: error.details } : { code };
}
