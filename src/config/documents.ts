const text = (value: unknown): string => String(value ?? "").trim();

function numberFromEnv(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function parseAllowedMime(value: string): string[] {
  const list = value.split(",").map((item) => text(item).toLowerCase()).filter(Boolean);
  return list.length ? Array.from(new Set(list)) : ["application/pdf", "image/jpeg", "image/png"];
}

export const DOCUMENT_VAULT_ROOT = text(process.env.DOCUMENT_VAULT_ROOT) || "/opt/ridematrix/DocuVault";
export const DOCUMENT_MAX_FILE_SIZE_MB = numberFromEnv(text(process.env.DOCUMENT_MAX_FILE_SIZE_MB), 10);
export const DOCUMENT_MAX_FILE_SIZE_BYTES = DOCUMENT_MAX_FILE_SIZE_MB * 1024 * 1024;
export const DOCUMENT_MAX_FILES_PER_CATEGORY = numberFromEnv(text(process.env.DOCUMENT_MAX_FILES_PER_CATEGORY), 5);
export const DOCUMENT_ALLOWED_MIME = parseAllowedMime(text(process.env.DOCUMENT_ALLOWED_MIME));
