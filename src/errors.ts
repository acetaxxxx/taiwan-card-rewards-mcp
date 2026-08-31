export class RewardServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RewardServiceError';
  }
}
