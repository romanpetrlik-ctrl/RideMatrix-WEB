export type CustomerPurgeMode = "anonymize" | "delete";

export type CustomerRetentionPolicy = {
  inactivityMonths: number;
  retentionMonths: number;
  purgeMode: CustomerPurgeMode;
};

function positiveMonths(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function readCustomerRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env
): CustomerRetentionPolicy {
  const requestedMode = String(env.CUSTOMER_PURGE_MODE || "anonymize").trim().toLowerCase();
  return {
    inactivityMonths: positiveMonths(env.CUSTOMER_INACTIVITY_MONTHS, 12),
    retentionMonths: positiveMonths(env.CUSTOMER_RETENTION_MONTHS, 24),
    purgeMode: requestedMode === "delete" ? "delete" : "anonymize"
  };
}

export function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}
