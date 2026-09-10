export type ProjectionKind = 'summary' | 'detail' | 'calculation' | 'audit';

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  evaluatedAt: string;
  dataVersion: string;
}

export class ProjectionTooLargeError extends Error {
  constructor() {
    super('PAYLOAD_TOO_LARGE');
    this.name = 'ProjectionTooLargeError';
  }
}

export class ProjectionInputError extends Error {
  readonly code = 'INVALID_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectionInputError';
  }
}

export function projectPage<T>(rows: readonly T[], options: { page: number; limit: number; maxItems?: number; maxBytes?: number; evaluatedAt: string; dataVersion: string; sortKey: (row: T) => string }): { items: T[]; pageInfo: PageInfo } {
  const maxItems = options.maxItems ?? 20;
  if (!Number.isSafeInteger(options.page) || options.page < 1) throw new ProjectionInputError('page must be a positive integer');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > maxItems) throw new ProjectionInputError(`limit must be an integer from 1 to ${maxItems}`);
  const sorted = [...rows].sort((a, b) => options.sortKey(a).localeCompare(options.sortKey(b)));
  const totalPages = Math.ceil(sorted.length / options.limit);
  const items = sorted.slice((options.page - 1) * options.limit, options.page * options.limit);
  const pageInfo: PageInfo = { page: options.page, limit: options.limit, total: sorted.length, totalPages, hasMore: options.page < totalPages, evaluatedAt: options.evaluatedAt, dataVersion: options.dataVersion };
  if (options.maxBytes !== undefined && Buffer.byteLength(JSON.stringify({ items, pageInfo }), 'utf8') > options.maxBytes) throw new ProjectionTooLargeError();
  return { items, pageInfo };
}
