export class RewardServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'RewardServiceError';
  }
}
