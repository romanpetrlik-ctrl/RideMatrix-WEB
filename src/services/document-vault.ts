import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOCUMENT_VAULT_ROOT } from "../config/documents";

const text = (value: unknown): string => String(value ?? "").trim();
const separatorPattern = /[\/\\]+/g;

export type DocumentEntityType = "driver" | "vehicle" | "operator";

function normalizeSegment(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[^\x00-\x7F]/g, "");
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export function sanitizeFolderSegment(value: string): string {
  const cleaned = text(value).replace(separatorPattern, "-").replace(/[.]{2,}/g, ".").replace(/[\x00-\x1F\x7F]/g, "");
  return normalizeSegment(cleaned).slice(0, 80);
}

export function sanitizeOriginalFilename(name: string): string {
  const base = path.basename(text(name));
  const safe = base.replace(/[\x00-\x1F\x7F]/g, "").replace(/[\/\\]+/g, "").trim();
  if (!safe || safe === "." || safe === "..") return "document";
  return safe.slice(0, 255);
}

function vehicleTypeFolder(licenseType: string | null | undefined): "HC" | "PHV" {
  return text(licenseType) === "hackney_carriage" ? "HC" : "PHV";
}

export function buildEntityVaultRelativeDir(input: {
  entityType: DocumentEntityType;
  uploadedAt: string;
  entityId: string;
  displayName?: string | null;
  registrationOrBadge?: string | null;
  vehicleLicenseType?: string | null;
}): string {
  const year = new Date(input.uploadedAt).getUTCFullYear();
  const safeYear = Number.isFinite(year) ? String(year) : String(new Date().getUTCFullYear());
  const suffix = sanitizeFolderSegment(input.entityId);
  const human = sanitizeFolderSegment(input.displayName || input.registrationOrBadge || input.entityId);
  const stable = `${human}__${suffix}`;
  if (input.entityType === "driver") return path.posix.join(safeYear, "Drivers", stable);
  if (input.entityType === "operator") return path.posix.join(safeYear, "Operators", stable);
  return path.posix.join(safeYear, "Vehicles", vehicleTypeFolder(input.vehicleLicenseType), stable);
}

export function buildEntityVaultRelativePath(input: {
  entityType: DocumentEntityType;
  uploadedAt: string;
  entityId: string;
  displayName?: string | null;
  registrationOrBadge?: string | null;
  vehicleLicenseType?: string | null;
  category: string;
  originalFilename: string;
}): string {
  const extension = sanitizeOriginalFilename(input.originalFilename).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "bin";
  const category = sanitizeFolderSegment(input.category);
  const dir = buildEntityVaultRelativeDir(input);
  return path.posix.join(dir, category, `${randomUUID()}.${extension}`);
}

export async function writeVaultFile(relativePath: string, content: Buffer): Promise<void> {
  if (relativePath.includes("..")) throw new Error("Invalid vault path.");
  const absolutePath = path.join(DOCUMENT_VAULT_ROOT, relativePath);
  const normalizedRoot = path.resolve(DOCUMENT_VAULT_ROOT);
  const normalizedPath = path.resolve(absolutePath);
  if (!normalizedPath.startsWith(`${normalizedRoot}${path.sep}`) && normalizedPath !== normalizedRoot) {
    throw new Error("Invalid vault path.");
  }
  await mkdir(path.dirname(normalizedPath), { recursive: true });
  await writeFile(normalizedPath, content);
}

export async function readVaultFile(relativePath: string): Promise<Buffer> {
  if (relativePath.includes("..")) throw new Error("Invalid vault path.");
  const absolutePath = path.join(DOCUMENT_VAULT_ROOT, relativePath);
  const normalizedRoot = path.resolve(DOCUMENT_VAULT_ROOT);
  const normalizedPath = path.resolve(absolutePath);
  if (!normalizedPath.startsWith(`${normalizedRoot}${path.sep}`) && normalizedPath !== normalizedRoot) {
    throw new Error("Invalid vault path.");
  }
  return readFile(normalizedPath);
}

export async function removeVaultFile(relativePath: string): Promise<void> {
  if (relativePath.includes("..")) throw new Error("Invalid vault path.");
  const absolutePath = path.join(DOCUMENT_VAULT_ROOT, relativePath);
  const normalizedRoot = path.resolve(DOCUMENT_VAULT_ROOT);
  const normalizedPath = path.resolve(absolutePath);
  if (!normalizedPath.startsWith(`${normalizedRoot}${path.sep}`) && normalizedPath !== normalizedRoot) {
    throw new Error("Invalid vault path.");
  }
  await rm(normalizedPath, { force: true });
}
