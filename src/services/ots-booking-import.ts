import { query } from "../database/connection";

const OTS_HOST = "ots-system.net";
const OTS_PATH = "/respond.php";
const OTS_PARAMETERS = ["r", "s", "j", "h", "w"] as const;
const MAX_HTML_BYTES = 1_000_000;

export type OtsBookingSnapshot = {
  reservationId: string;
  pickupTime: string;
  pickup: string;
  dropoff: string;
  passengerCount: number;
  passengerName: string;
};

export type OtsImportActor = { accountId: string; email: string };

export class OtsBookingImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtsBookingImportError";
  }
}

type ValidatedOtsLink = { url: URL; reservationId: string };

export function validateOtsBookingUrl(value: string): ValidatedOtsLink {
  if (value.length > 2_000) {
    throw new OtsBookingImportError("Odkaz OTS je příliš dlouhý.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new OtsBookingImportError("Vložte platný HTTPS odkaz OTS.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== OTS_HOST ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.pathname !== OTS_PATH ||
    url.hash
  ) {
    throw new OtsBookingImportError("Odkaz musí vést na https://ots-system.net/respond.php.");
  }

  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== OTS_PARAMETERS.length ||
    keys.some((key) => !OTS_PARAMETERS.includes(key as (typeof OTS_PARAMETERS)[number])) ||
    OTS_PARAMETERS.some((key) => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)?.trim())
  ) {
    throw new OtsBookingImportError("Odkaz musí obsahovat právě jednou parametry r, s, j, h a w.");
  }

  return { url, reservationId: url.searchParams.get("r")! };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return named[name.toLowerCase()] ?? entity;
    const hex = name[1]?.toLowerCase() === "x";
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  });
}

function cleanHtmlText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|dt|dd|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function normalizeLabel(value: string): string {
  return cleanHtmlText(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LABELS: Record<Exclude<keyof OtsBookingSnapshot, "reservationId" | "pickupTime"> | "pickupTime" | "date" | "time", string[]> = {
  pickupTime: ["pick up date time", "pickup date time", "journey date time", "date time", "date and time"],
  pickup: ["pickup", "pick up", "pickup location", "pick up location", "collection", "collection address", "from"],
  dropoff: ["dropoff", "drop off", "dropoff location", "drop off location", "destination", "destination address", "to"],
  passengerCount: ["passengers", "number of passengers", "passenger count", "pax"],
  passengerName: ["passenger name", "lead passenger", "customer name", "name"],
  date: ["date", "journey date", "pickup date", "pick up date"],
  time: ["time", "journey time", "pickup time", "pick up time"]
};

function extractPairs(html: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const addPair = (label: string, value: string) => {
    const normalized = normalizeLabel(label).replace(/:$/, "");
    const cleaned = cleanHtmlText(value);
    if (normalized && cleaned) pairs.set(normalized, cleaned);
  };

  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)\s*>/gi)]
      .map(([, cell]) => cleanHtmlText(cell));
    if (cells.length >= 2) addPair(cells[0], cells.slice(1).join(" "));
  }
  for (const [, term, description] of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt\s*>\s*<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi)) {
    addPair(term, description);
  }

  const text = decodeHtmlEntities(html
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|dt|dd|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " "));
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:\n]{2,80})\s*:\s*(.{1,500})\s*$/.exec(line);
    if (match) addPair(match[1], match[2]);
  }
  return pairs;
}

function pairValue(pairs: Map<string, string>, labels: string[]): string {
  for (const label of labels) {
    const value = pairs.get(normalizeLabel(label));
    if (value) return value;
  }
  return "";
}

export function parseOtsBookingHtml(html: string, reservationId: string): OtsBookingSnapshot {
  if (!html.trim() || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new OtsBookingImportError("Stránka OTS je prázdná nebo příliš velká.");
  }

  const pairs = extractPairs(html);
  const date = pairValue(pairs, LABELS.date);
  const time = pairValue(pairs, LABELS.time);
  const passengerCountText = pairValue(pairs, LABELS.passengerCount);
  const passengerCount = /^\d{1,3}$/.test(passengerCountText) ? Number(passengerCountText) : 0;
  const snapshot: OtsBookingSnapshot = {
    reservationId,
    pickupTime: pairValue(pairs, LABELS.pickupTime) || [date, time].filter(Boolean).join(" "),
    pickup: pairValue(pairs, LABELS.pickup),
    dropoff: pairValue(pairs, LABELS.dropoff),
    passengerCount,
    passengerName: pairValue(pairs, LABELS.passengerName)
  };
  if (!snapshot.pickupTime || !snapshot.pickup || !snapshot.dropoff || !snapshot.passengerName || !passengerCount) {
    throw new OtsBookingImportError("Strukturu stránky OTS se nepodařilo rozpoznat. Zkontrolujte odkaz a údaje zadejte ručně.");
  }
  return snapshot;
}

async function responseTextLimited(response: Response): Promise<string> {
  if (!response.body) throw new OtsBookingImportError("Stránka OTS nevrátila žádný obsah.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new OtsBookingImportError("Stránka OTS je příliš velká.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function fetchOtsBookingHtml(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new OtsBookingImportError("Stránka OTS není dostupná nebo vypršel časový limit.");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new OtsBookingImportError("Stránka OTS přesměrovala požadavek; import byl z bezpečnostních důvodů zastaven.");
  }
  if (response.status === 404 || response.status === 410) {
    throw new OtsBookingImportError("Odkaz OTS vypršel nebo už není platný.");
  }
  if (!response.ok) {
    throw new OtsBookingImportError("Stránka OTS není dostupná. Zkuste to později nebo údaje zadejte ručně.");
  }
  const contentType = response.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().includes("text/html")) {
    throw new OtsBookingImportError("Odkaz OTS nevrátil HTML stránku s detailem zakázky.");
  }
  return responseTextLimited(response);
}

export async function findOtsBookingImport(reservationId: string): Promise<boolean> {
  const result = await query(
    "SELECT 1 FROM ots_booking_imports WHERE reservation_id = $1 LIMIT 1",
    [reservationId]
  );
  return Boolean(result.rowCount);
}

type SaveOtsBookingImportInput = {
  reservationId: string;
  sourceUrl: string;
  snapshot: OtsBookingSnapshot;
  actor: OtsImportActor;
};

export async function saveOtsBookingImport(input: SaveOtsBookingImportInput): Promise<boolean> {
  const result = await query(
    `INSERT INTO ots_booking_imports (reservation_id, source_url, snapshot, imported_by_account_id, imported_by_email)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (reservation_id) DO NOTHING
     RETURNING reservation_id`,
    [
      input.reservationId,
      input.sourceUrl,
      JSON.stringify(input.snapshot),
      input.actor.accountId,
      input.actor.email
    ]
  );
  return Boolean(result.rowCount);
}

export type OtsBookingImportDependencies = {
  findExisting: (reservationId: string) => Promise<boolean>;
  fetchHtml: (url: string) => Promise<string>;
  save: (input: SaveOtsBookingImportInput) => Promise<boolean>;
};

const defaultDependencies: OtsBookingImportDependencies = {
  findExisting: findOtsBookingImport,
  fetchHtml: (url) => fetchOtsBookingHtml(url),
  save: saveOtsBookingImport
};

export async function importOtsBookingFromLink(
  value: string,
  actor: OtsImportActor,
  dependencies: OtsBookingImportDependencies = defaultDependencies
): Promise<{ status: "duplicate"; reservationId: string } | { status: "imported"; snapshot: OtsBookingSnapshot }> {
  const validated = validateOtsBookingUrl(value);
  if (await dependencies.findExisting(validated.reservationId)) {
    return { status: "duplicate", reservationId: validated.reservationId };
  }

  const html = await dependencies.fetchHtml(validated.url.href);
  const snapshot = parseOtsBookingHtml(html, validated.reservationId);
  const saved = await dependencies.save({
    reservationId: validated.reservationId,
    sourceUrl: validated.url.href,
    snapshot,
    actor
  });
  return saved
    ? { status: "imported", snapshot }
    : { status: "duplicate", reservationId: validated.reservationId };
}
