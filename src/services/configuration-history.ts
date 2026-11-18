/** Number of entries shown inline on a settings page before "View all history". */
export const RECENT_CONFIGURATION_HISTORY_LIMIT = 3;
/** Entries per page on a dedicated configuration history page. */
export const CONFIGURATION_HISTORY_PER_PAGE = 20;

export type ConfigurationHistoryEntry = {
  version: number;
  actorEmail: string | null;
  createdAt: string;
};

export type ConfigurationHistoryPage = {
  entries: ConfigurationHistoryEntry[];
  page: number;
  perPage: number;
  totalPages: number;
  totalRecords: number;
};

/** Parses a `?page=` query value; anything other than a positive integer falls back to page 1. */
export function parseHistoryPageParam(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return 1;
  const page = Number(raw);
  return page >= 1 ? page : 1;
}

/**
 * Clamps a requested page into range (out-of-range pages show the last page,
 * matching the customers list) and returns the SQL offset for it.
 */
export function resolveHistoryPage(
  requestedPage: number,
  totalRecords: number,
  perPage: number = CONFIGURATION_HISTORY_PER_PAGE
): { page: number; perPage: number; totalPages: number; offset: number } {
  const totalPages = Math.max(1, Math.ceil(totalRecords / perPage));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), totalPages);
  return { page, perPage, totalPages, offset: (page - 1) * perPage };
}
