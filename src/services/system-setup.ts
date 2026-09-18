import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";
import { describeUserStatusColumn, normalizeUserEmail, resolveInvitedUserStatus } from "./staff-users";

type Queryable = Pool | PoolClient;

export const INITIAL_SETUP_KEY = "initial_system_setup";
export const INITIAL_BOOTSTRAP_KEY = "initial_superuser_bootstrap";

export const INITIAL_SETUP_STEPS = [
  "bootstrap_superuser",
  "operator_profile",
  "registered_pho_address",
  "operational_address",
  "pho_licence",
  "licence_document",
  "review_confirmation",
  "completed"
] as const;

export type SetupStep = (typeof INITIAL_SETUP_STEPS)[number];

export type SetupActor = {
  userId: string;
  email: string;
  roles: string[];
};

export type OperatorProfileInput = {
  legalName: string;
  tradingName: string | null;
  licenceHolderName: string;
  status: "setup_required" | "active" | "suspended" | "archived";
};

export type OperatorAddressInput = {
  addressType: "registered_pho" | "operational";
  formattedAddress: string;
  houseNameNumber: string | null;
  addressLine1: string;
  addressLine2: string | null;
  addressLine3: string | null;
  cityTown: string;
  county: string | null;
  state: string | null;
  postcode: string;
  countryCode: string;
  countryName: string;
  latitude: number | null;
  longitude: number | null;
  providerName: string | null;
  providerPlaceId: string | null;
};

export type OperatorLicenceInput = {
  licenceNumber: string;
  licensingAuthorityId: string;
  validFrom: string;
  validTo: string | null;
};

export type SetupOverview = {
  bootstrapCompleted: boolean;
  setupCompleted: boolean;
  currentStep: SetupStep;
  operatorId: string | null;
  operator:
    | {
        id: string;
        legalName: string;
        tradingName: string | null;
        licenceHolderName: string;
        status: string;
      }
    | null;
  addresses: {
    registeredPho: boolean;
    operational: boolean;
  };
  licence: {
    id: string;
    licenceNumber: string;
    licensingAuthorityId: string | null;
    validFrom: string;
    validTo: string | null;
    status: string;
  } | null;
  latestDocument:
    | {
        id: string;
        originalFilename: string;
        mimeType: string;
        uploadedAt: string;
      }
    | null;
};

export type TestAccountDefinition = {
  email: string;
  roleKey: string;
  purpose: string;
};

export const SYSTEM_TEST_ACCOUNT_DEFINITIONS: TestAccountDefinition[] = [
  {
    email: "test.staff@ridematrix.uk",
    roleKey: "staff",
    purpose: "Internal operations, pricing, and workflow validation without financial impact."
  },
  {
    email: "test.driver@ridematrix.uk",
    roleKey: "driver",
    purpose: "Driver workflow and dispatch validation account."
  },
  {
    email: "test.customer@ridematrix.uk",
    roleKey: "customer",
    purpose: "Customer booking and notification test account."
  },
  {
    email: "test.corporate@ridematrix.uk",
    roleKey: "corporate",
    purpose: "Corporate account and invoicing-flow test account."
  },
  {
    email: "test.partner@ridematrix.uk",
    roleKey: "partner",
    purpose: "Partner integration and contract-flow test account."
  },
  {
    email: "test.tour-operator@ridematrix.uk",
    roleKey: "tour_operator",
    purpose: "Tour-operator specific booking-flow test account."
  },
  {
    email: "test.affiliate@ridematrix.uk",
    roleKey: "affiliate",
    purpose: "Affiliate commission and referral workflow validation account."
  },
  {
    email: "test.tech-support@ridematrix.uk",
    roleKey: "tech_support",
    purpose: "Technical support test account for diagnostics and sandboxed notifications."
  }
];

const LEGACY_TEST_PRIVILEGED_EMAILS = ["test.superuser@ridematrix.uk", "test.admin@ridematrix.uk"] as const;

export class SetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupValidationError";
  }
}

export class MissingAuthRoleError extends Error {
  constructor(readonly missingRoleKeys: string[]) {
    super(
      `Required role(s) missing in authentication catalogue: ${missingRoleKeys.join(
        ", "
      )}. Provision these roles in auth before completing setup.`
    );
    this.name = "MissingAuthRoleError";
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized ? normalized : null;
}

function normalizeCountryCode(value: unknown): string {
  return normalizeText(value).toUpperCase();
}

function toDateIsoDay(value: string): string {
  const normalized = normalizeText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new SetupValidationError("Enter a valid date in YYYY-MM-DD format.");
  }
  return normalized;
}

function validateOperatorProfile(input: OperatorProfileInput): OperatorProfileInput {
  const legalName = normalizeText(input.legalName);
  const licenceHolderName = normalizeText(input.licenceHolderName);
  const tradingName = normalizeOptionalText(input.tradingName);
  const status = normalizeText(input.status) as OperatorProfileInput["status"];

  if (!legalName) {
    throw new SetupValidationError("Legal name is required.");
  }
  if (!licenceHolderName) {
    throw new SetupValidationError("Licence holder name is required.");
  }
  if (!["setup_required", "active", "suspended", "archived"].includes(status)) {
    throw new SetupValidationError("Unsupported operator status.");
  }

  return {
    legalName,
    tradingName,
    licenceHolderName,
    status
  };
}

function validateAddress(input: OperatorAddressInput): OperatorAddressInput {
  const formattedAddress = normalizeText(input.formattedAddress);
  const addressLine1 = normalizeText(input.addressLine1);
  const cityTown = normalizeText(input.cityTown);
  const postcode = normalizeText(input.postcode);
  const countryCode = normalizeCountryCode(input.countryCode);
  const countryName = normalizeText(input.countryName);
  const houseNameNumber = normalizeOptionalText(input.houseNameNumber);
  const addressLine2 = normalizeOptionalText(input.addressLine2);
  const addressLine3 = normalizeOptionalText(input.addressLine3);
  const county = normalizeOptionalText(input.county);
  const state = normalizeOptionalText(input.state);
  const providerName = normalizeOptionalText(input.providerName);
  const providerPlaceId = normalizeOptionalText(input.providerPlaceId);
  const latitude = input.latitude === null ? null : Number(input.latitude);
  const longitude = input.longitude === null ? null : Number(input.longitude);

  if (!["registered_pho", "operational"].includes(input.addressType)) {
    throw new SetupValidationError("Unsupported address type.");
  }
  if (!formattedAddress) {
    throw new SetupValidationError("Formatted address is required.");
  }
  if (!addressLine1) {
    throw new SetupValidationError("Address line 1 is required.");
  }
  if (!cityTown) {
    throw new SetupValidationError("City / Town is required.");
  }
  if (!postcode) {
    throw new SetupValidationError("Postcode is required.");
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new SetupValidationError("Country code must be a two-letter ISO code.");
  }
  if (!countryName) {
    throw new SetupValidationError("Country name is required.");
  }

  if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
    throw new SetupValidationError("Latitude must be between -90 and 90.");
  }

  if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
    throw new SetupValidationError("Longitude must be between -180 and 180.");
  }

  return {
    addressType: input.addressType,
    formattedAddress,
    houseNameNumber,
    addressLine1,
    addressLine2,
    addressLine3,
    cityTown,
    county,
    state,
    postcode,
    countryCode,
    countryName,
    latitude,
    longitude,
    providerName,
    providerPlaceId
  };
}

function validateLicence(input: OperatorLicenceInput): OperatorLicenceInput {
  const licenceNumber = normalizeText(input.licenceNumber);
  const licensingAuthorityId = normalizeText(input.licensingAuthorityId);
  const validFrom = toDateIsoDay(input.validFrom);
  const validTo = normalizeOptionalText(input.validTo);
  const validToIso = validTo ? toDateIsoDay(validTo) : null;

  if (!licenceNumber) {
    throw new SetupValidationError("Licence number is required.");
  }
  if (!licensingAuthorityId) {
    throw new SetupValidationError("Licensing authority is required.");
  }
  if (validToIso && validToIso <= validFrom) {
    throw new SetupValidationError("Valid-to date must be later than valid-from date.");
  }

  return {
    licenceNumber,
    licensingAuthorityId,
    validFrom,
    validTo: validToIso
  };
}

function normalizeActor(actor: SetupActor): SetupActor {
  return {
    userId: normalizeText(actor.userId),
    email: normalizeUserEmail(actor.email),
    roles: Array.isArray(actor.roles) ? actor.roles.map((role) => normalizeText(role)).filter(Boolean) : []
  };
}

async function readBootstrap(runner?: Queryable): Promise<{
  status: "pending" | "completed";
  installerUserId: string | null;
  installerEmailNormalized: string | null;
} | null> {
  const result = await query<{
    status: "pending" | "completed";
    installer_user_id: string | null;
    installer_email_normalized: string | null;
  }>(
    `SELECT status, installer_user_id, installer_email_normalized
       FROM system_setup_bootstrap
      WHERE bootstrap_key = $1
      LIMIT 1`,
    [INITIAL_BOOTSTRAP_KEY],
    runner
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    status: row.status,
    installerUserId: row.installer_user_id,
    installerEmailNormalized: row.installer_email_normalized
  };
}

async function writeSetupStep(
  step: SetupStep,
  actor: SetupActor,
  client: Queryable
): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO system_setup_steps
      (setup_key, step_key, completed_at, completed_by_user_id, completed_by_user_email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (setup_key, step_key)
     DO UPDATE SET
       completed_at = EXCLUDED.completed_at,
       completed_by_user_id = EXCLUDED.completed_by_user_id,
       completed_by_user_email = EXCLUDED.completed_by_user_email`,
    [INITIAL_SETUP_KEY, step, now, actor.userId || null, actor.email || null],
    client
  );
}

export async function appendSetupAuditEvent(input: {
  eventName: string;
  actor: SetupActor;
  summary: string;
  operatorId?: string | null;
  metadata?: unknown;
  client?: Queryable;
}): Promise<void> {
  const actor = normalizeActor(input.actor);
  await query(
    `INSERT INTO system_setup_audit_events
      (id, occurred_at, event_name, actor_user_id, actor_user_email, setup_key, operator_id, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      randomUUID(),
      new Date().toISOString(),
      input.eventName,
      actor.userId || null,
      actor.email || null,
      INITIAL_SETUP_KEY,
      input.operatorId || null,
      input.summary,
      JSON.stringify(input.metadata ?? {})
    ],
    input.client
  );
}

async function getSetupStateRow(
  runner?: Queryable
): Promise<{ id: string; operator_id: string; status: string } | null> {
  const result = await query<{ id: string; operator_id: string; status: string }>(
    `SELECT id, operator_id, status
       FROM system_setup_state
      WHERE setup_key = $1
      LIMIT 1`,
    [INITIAL_SETUP_KEY],
    runner
  );
  return result.rows[0] ?? null;
}

async function getOperatorOverview(
  operatorId: string,
  runner?: Queryable
): Promise<SetupOverview["operator"]> {
  const result = await query<{
    id: string;
    legal_name: string;
    trading_name: string | null;
    license_holder_name: string;
    status: string;
  }>(
    `SELECT id, legal_name, trading_name, license_holder_name, status
       FROM operators
      WHERE id = $1
      LIMIT 1`,
    [operatorId],
    runner
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    legalName: row.legal_name,
    tradingName: row.trading_name,
    licenceHolderName: row.license_holder_name,
    status: row.status
  };
}

async function getLatestLicence(
  operatorId: string,
  runner?: Queryable
): Promise<SetupOverview["licence"]> {
  const result = await query<{
    id: string;
    licence_number: string;
    licensing_authority_id: string | null;
    valid_from: string;
    valid_to: string | null;
    status: string;
  }>(
    `SELECT id, licence_number, licensing_authority_id, valid_from::text, valid_to::text, status
       FROM operator_licences
      WHERE operator_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [operatorId],
    runner
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    licenceNumber: row.licence_number,
    licensingAuthorityId: row.licensing_authority_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status
  };
}

async function getLatestLicenceDocument(
  licenceId: string,
  runner?: Queryable
): Promise<SetupOverview["latestDocument"]> {
  const result = await query<{
    id: string;
    original_filename: string;
    mime_type: string;
    uploaded_at: string;
  }>(
    `SELECT id, original_filename, mime_type, uploaded_at
       FROM operator_licence_documents
      WHERE licence_id = $1 AND is_latest = TRUE
      LIMIT 1`,
    [licenceId],
    runner
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at
  };
}

export async function getSetupOverview(runner?: Queryable): Promise<SetupOverview> {
  const bootstrap = await readBootstrap(runner);
  const setupState = await getSetupStateRow(runner);
  const operatorId = setupState?.operator_id ?? null;
  const operator = operatorId ? await getOperatorOverview(operatorId, runner) : null;
  const addressResult = operatorId
    ? await query<{ address_type: "registered_pho" | "operational" }>(
        `SELECT address_type
           FROM operator_addresses
          WHERE operator_id = $1`,
        [operatorId],
        runner
      )
    : { rows: [] as Array<{ address_type: "registered_pho" | "operational" }> };
  const addressTypes = new Set(addressResult.rows.map((row) => row.address_type));
  const licence = operatorId ? await getLatestLicence(operatorId, runner) : null;
  const latestDocument = licence ? await getLatestLicenceDocument(licence.id, runner) : null;

  let currentStep: SetupStep = "bootstrap_superuser";
  if (!bootstrap || bootstrap.status !== "completed") {
    currentStep = "bootstrap_superuser";
  } else if (!operator) {
    currentStep = "operator_profile";
  } else if (!addressTypes.has("registered_pho")) {
    currentStep = "registered_pho_address";
  } else if (!addressTypes.has("operational")) {
    currentStep = "operational_address";
  } else if (!licence) {
    currentStep = "pho_licence";
  } else if (!latestDocument) {
    currentStep = "licence_document";
  } else if (setupState?.status === "completed") {
    currentStep = "completed";
  } else {
    currentStep = "review_confirmation";
  }

  return {
    bootstrapCompleted: bootstrap?.status === "completed",
    setupCompleted: setupState?.status === "completed",
    currentStep,
    operatorId,
    operator,
    addresses: {
      registeredPho: addressTypes.has("registered_pho"),
      operational: addressTypes.has("operational")
    },
    licence,
    latestDocument
  };
}

export function isSetupAdministrationRole(roles: string[]): boolean {
  return roles.includes("superuser") || roles.includes("admin");
}

function parseAllowedBootstrapEmails(): string[] {
  const raw = String(process.env.INITIAL_SETUP_ALLOWED_EMAILS || "");
  return raw
    .split(",")
    .map((entry) => normalizeUserEmail(entry))
    .filter(Boolean);
}

async function resolveUserByIdOrEmail(
  userId: string,
  normalizedEmail: string,
  runner: Queryable
): Promise<{ id: string; email: string }> {
  const byId = await query<{ id: string; email: string }>(
    `SELECT id, email
       FROM users
      WHERE id::text = $1
      LIMIT 1`,
    [userId],
    runner
  );
  if (byId.rows[0]) {
    return byId.rows[0];
  }

  const byEmail = await query<{ id: string; email: string }>(
    `SELECT id, email
       FROM users
      WHERE lower(email) = $1
      LIMIT 1`,
    [normalizedEmail],
    runner
  );
  if (byEmail.rows[0]) {
    return byEmail.rows[0];
  }

  const inserted = await query<{ id: string; email: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id, email`,
    [normalizedEmail],
    runner
  );
  return inserted.rows[0];
}

async function resolveRoleIdByKey(roleKey: string, runner: Queryable): Promise<number | null> {
  const result = await query<{ id: number }>(
    `SELECT id
       FROM roles
      WHERE key = $1
      LIMIT 1`,
    [roleKey],
    runner
  );
  return result.rows[0]?.id ?? null;
}

export async function bootstrapRealInstallerSuperuser(input: {
  actor: SetupActor;
  installerEmail: string;
}): Promise<void> {
  const actor = normalizeActor(input.actor);
  const installerEmail = normalizeUserEmail(input.installerEmail);

  if (!actor.userId || !actor.email) {
    throw new SetupValidationError("An authenticated installer session is required.");
  }
  if (!installerEmail) {
    throw new SetupValidationError("Installer email is required.");
  }
  if (installerEmail !== actor.email) {
    throw new SetupValidationError(
      "Installer email must match the currently authenticated account to verify ownership."
    );
  }

  const allowedBootstrapEmails = parseAllowedBootstrapEmails();
  if (
    !actor.roles.includes("superuser") &&
    allowedBootstrapEmails.length > 0 &&
    !allowedBootstrapEmails.includes(installerEmail)
  ) {
    throw new SetupValidationError(
      "This account is not allowed for initial superuser bootstrap. Configure INITIAL_SETUP_ALLOWED_EMAILS."
    );
  }

  await withTransaction(async (client) => {
    const bootstrap = await readBootstrap(client);
    if (bootstrap?.status === "completed") {
      if (bootstrap.installerUserId !== actor.userId) {
        throw new SetupValidationError("Initial superuser bootstrap has already been completed.");
      }
      return;
    }

    const superuserRoleId = await resolveRoleIdByKey("superuser", client);
    if (!superuserRoleId) {
      throw new MissingAuthRoleError(["superuser"]);
    }

    const user = await resolveUserByIdOrEmail(actor.userId, installerEmail, client);
    await query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, superuserRoleId],
      client
    );

    const now = new Date().toISOString();
    await query(
      `INSERT INTO system_setup_bootstrap
        (id, bootstrap_key, status, installer_user_id, installer_email_normalized, created_at, updated_at, completed_at)
       VALUES ($1, $2, 'completed', $3, $4, $5, $5, $5)
       ON CONFLICT (bootstrap_key)
       DO UPDATE SET
         status = 'completed',
         installer_user_id = EXCLUDED.installer_user_id,
         installer_email_normalized = EXCLUDED.installer_email_normalized,
         updated_at = EXCLUDED.updated_at,
         completed_at = EXCLUDED.completed_at`,
      [randomUUID(), INITIAL_BOOTSTRAP_KEY, user.id, installerEmail, now],
      client
    );

    await writeSetupStep("bootstrap_superuser", actor, client);
    await appendSetupAuditEvent({
      eventName: "bootstrap_superuser_completed",
      actor,
      summary: "Initial superuser bootstrap completed for verified installer account.",
      metadata: {
        installerUserId: user.id,
        installerEmail
      },
      client
    });
  });
}

async function resolveOrCreateSetupOperator(
  profile: OperatorProfileInput,
  actor: SetupActor,
  client: Queryable
): Promise<string> {
  const setupState = await getSetupStateRow(client);
  const now = new Date().toISOString();

  if (setupState?.operator_id) {
    await query(
      `UPDATE operators
          SET legal_name = $2,
              trading_name = $3,
              license_holder_name = $4,
              status = $5,
              updated_by_user_id = $6,
              updated_by_user_email = $7,
              updated_at = $8
        WHERE id = $1`,
      [
        setupState.operator_id,
        profile.legalName,
        profile.tradingName,
        profile.licenceHolderName,
        profile.status,
        actor.userId || null,
        actor.email || null,
        now
      ],
      client
    );
    return setupState.operator_id;
  }

  const operatorId = randomUUID();
  await query(
    `INSERT INTO operators
      (id, legal_name, trading_name, license_holder_name, status, created_by_user_id, created_by_user_email, updated_by_user_id, updated_by_user_email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7, $8, $8)`,
    [
      operatorId,
      profile.legalName,
      profile.tradingName,
      profile.licenceHolderName,
      profile.status,
      actor.userId || null,
      actor.email || null,
      now
    ],
    client
  );

  await query(
    `INSERT INTO system_setup_state
      (id, operator_id, setup_key, status, started_at, started_by_user_id, started_by_user_email, last_edited_at, last_edited_by_user_id, last_edited_by_user_email)
     VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $4, $5, $6)
     ON CONFLICT (setup_key)
     DO UPDATE SET
       operator_id = EXCLUDED.operator_id,
       status = CASE
         WHEN system_setup_state.status = 'completed' THEN system_setup_state.status
         ELSE 'in_progress'
       END,
       started_at = COALESCE(system_setup_state.started_at, EXCLUDED.started_at),
       started_by_user_id = COALESCE(system_setup_state.started_by_user_id, EXCLUDED.started_by_user_id),
       started_by_user_email = COALESCE(system_setup_state.started_by_user_email, EXCLUDED.started_by_user_email),
       last_edited_at = EXCLUDED.last_edited_at,
       last_edited_by_user_id = EXCLUDED.last_edited_by_user_id,
       last_edited_by_user_email = EXCLUDED.last_edited_by_user_email`,
    [randomUUID(), operatorId, INITIAL_SETUP_KEY, now, actor.userId || null, actor.email || null],
    client
  );

  return operatorId;
}

export async function saveOperatorProfile(
  actorInput: SetupActor,
  profileInput: OperatorProfileInput
): Promise<string> {
  const actor = normalizeActor(actorInput);
  const profile = validateOperatorProfile(profileInput);
  const bootstrap = await readBootstrap();
  if (!bootstrap || bootstrap.status !== "completed") {
    throw new SetupValidationError("Complete superuser bootstrap before editing operator profile.");
  }

  return withTransaction(async (client) => {
    const operatorId = await resolveOrCreateSetupOperator(profile, actor, client);
    const now = new Date().toISOString();
    await query(
      `UPDATE system_setup_state
          SET status = CASE WHEN status = 'completed' THEN status ELSE 'in_progress' END,
              last_edited_at = $2,
              last_edited_by_user_id = $3,
              last_edited_by_user_email = $4
        WHERE setup_key = $1`,
      [INITIAL_SETUP_KEY, now, actor.userId || null, actor.email || null],
      client
    );
    await writeSetupStep("operator_profile", actor, client);
    await appendSetupAuditEvent({
      eventName: "operator_profile_saved",
      actor,
      operatorId,
      summary: "Operator profile saved.",
      metadata: {
        legalName: profile.legalName,
        tradingName: profile.tradingName,
        licenceHolderName: profile.licenceHolderName,
        status: profile.status
      },
      client
    });
    return operatorId;
  });
}

function checksumSha256(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export async function saveOperatorAddress(
  actorInput: SetupActor,
  inputAddress: OperatorAddressInput
): Promise<void> {
  const actor = normalizeActor(actorInput);
  const address = validateAddress(inputAddress);

  await withTransaction(async (client) => {
    const state = await getSetupStateRow(client);
    if (!state?.operator_id) {
      throw new SetupValidationError("Complete operator profile before saving addresses.");
    }
    if (state.status === "completed") {
      throw new SetupValidationError("Initial setup is already completed and locked.");
    }

    const now = new Date().toISOString();
    await query(
      `INSERT INTO operator_addresses
        (id, operator_id, address_type, formatted_address, house_name_number, address_line1, address_line2, address_line3,
         city_town, county, state, postcode, country_code, country_name, latitude, longitude, provider_name, provider_place_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)
       ON CONFLICT (operator_id, address_type)
       DO UPDATE SET
         formatted_address = EXCLUDED.formatted_address,
         house_name_number = EXCLUDED.house_name_number,
         address_line1 = EXCLUDED.address_line1,
         address_line2 = EXCLUDED.address_line2,
         address_line3 = EXCLUDED.address_line3,
         city_town = EXCLUDED.city_town,
         county = EXCLUDED.county,
         state = EXCLUDED.state,
         postcode = EXCLUDED.postcode,
         country_code = EXCLUDED.country_code,
         country_name = EXCLUDED.country_name,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         provider_name = EXCLUDED.provider_name,
         provider_place_id = EXCLUDED.provider_place_id,
         updated_at = EXCLUDED.updated_at`,
      [
        randomUUID(),
        state.operator_id,
        address.addressType,
        address.formattedAddress,
        address.houseNameNumber,
        address.addressLine1,
        address.addressLine2,
        address.addressLine3,
        address.cityTown,
        address.county,
        address.state,
        address.postcode,
        address.countryCode,
        address.countryName,
        address.latitude,
        address.longitude,
        address.providerName,
        address.providerPlaceId,
        now
      ],
      client
    );

    await query(
      `UPDATE system_setup_state
          SET last_edited_at = $2,
              last_edited_by_user_id = $3,
              last_edited_by_user_email = $4
        WHERE setup_key = $1`,
      [INITIAL_SETUP_KEY, now, actor.userId || null, actor.email || null],
      client
    );
    await writeSetupStep(
      address.addressType === "registered_pho" ? "registered_pho_address" : "operational_address",
      actor,
      client
    );
    await appendSetupAuditEvent({
      eventName: "operator_address_saved",
      actor,
      operatorId: state.operator_id,
      summary: `Operator ${address.addressType} address saved.`,
      metadata: {
        addressType: address.addressType,
        postcode: address.postcode,
        countryCode: address.countryCode
      },
      client
    });
  });
}

export async function saveOperatorLicence(
  actorInput: SetupActor,
  inputLicence: OperatorLicenceInput
): Promise<string> {
  const actor = normalizeActor(actorInput);
  const licence = validateLicence(inputLicence);

  return withTransaction(async (client) => {
    const state = await getSetupStateRow(client);
    if (!state?.operator_id) {
      throw new SetupValidationError("Complete operator profile before saving licence.");
    }
    if (state.status === "completed") {
      throw new SetupValidationError("Initial setup is already completed and locked.");
    }

    const authorityExists = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM licensing_authorities WHERE id = $1 AND active = TRUE) AS exists`,
      [licence.licensingAuthorityId],
      client
    );
    if (!authorityExists.rows[0]?.exists) {
      throw new SetupValidationError("Selected licensing authority is not available.");
    }

    const existing = await query<{ id: string }>(
      `SELECT id
         FROM operator_licences
        WHERE operator_id = $1 AND licence_type = 'pho'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [state.operator_id],
      client
    );
    const now = new Date().toISOString();
    const licenceId = existing.rows[0]?.id ?? randomUUID();

    if (existing.rows[0]) {
      await query(
        `UPDATE operator_licences
            SET licence_number = $2,
                licensing_authority_id = $3,
                valid_from = $4::date,
                valid_to = $5::date,
                status = 'draft',
                updated_by_user_id = $6,
                updated_by_user_email = $7,
                updated_at = $8
          WHERE id = $1`,
        [
          licenceId,
          licence.licenceNumber,
          licence.licensingAuthorityId,
          licence.validFrom,
          licence.validTo,
          actor.userId || null,
          actor.email || null,
          now
        ],
        client
      );
    } else {
      await query(
        `INSERT INTO operator_licences
          (id, operator_id, licence_type, licence_number, licensing_authority_id, valid_from, valid_to, status, created_by_user_id, created_by_user_email, updated_by_user_id, updated_by_user_email, created_at, updated_at)
         VALUES ($1, $2, 'pho', $3, $4, $5::date, $6::date, 'draft', $7, $8, $7, $8, $9, $9)`,
        [
          licenceId,
          state.operator_id,
          licence.licenceNumber,
          licence.licensingAuthorityId,
          licence.validFrom,
          licence.validTo,
          actor.userId || null,
          actor.email || null,
          now
        ],
        client
      );
    }

    await query(
      `UPDATE system_setup_state
          SET last_edited_at = $2,
              last_edited_by_user_id = $3,
              last_edited_by_user_email = $4
        WHERE setup_key = $1`,
      [INITIAL_SETUP_KEY, now, actor.userId || null, actor.email || null],
      client
    );
    await writeSetupStep("pho_licence", actor, client);
    await appendSetupAuditEvent({
      eventName: existing.rows[0] ? "operator_licence_updated" : "operator_licence_created",
      actor,
      operatorId: state.operator_id,
      summary: "PHO licence saved.",
      metadata: {
        licenceId,
        licensingAuthorityId: licence.licensingAuthorityId,
        validFrom: licence.validFrom,
        validTo: licence.validTo
      },
      client
    });

    return licenceId;
  });
}

export function validateLicenceDocumentFile(file: {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
}): void {
  const allowedMime = new Set(["application/pdf", "image/jpeg", "image/png"]);
  if (!file || !file.buffer || file.size <= 0) {
    throw new SetupValidationError("Upload a non-empty licence document.");
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new SetupValidationError("Licence document must be 10 MB or smaller.");
  }
  if (!allowedMime.has(file.mimetype)) {
    throw new SetupValidationError("Only PDF, PNG, or JPEG licence documents are allowed.");
  }
}

export async function saveOperatorLicenceDocument(
  actorInput: SetupActor,
  file: {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }
): Promise<void> {
  const actor = normalizeActor(actorInput);
  validateLicenceDocumentFile(file);

  await withTransaction(async (client) => {
    const state = await getSetupStateRow(client);
    if (!state?.operator_id) {
      throw new SetupValidationError("Complete licence details before uploading documents.");
    }
    if (state.status === "completed") {
      throw new SetupValidationError("Initial setup is already completed and locked.");
    }

    const licence = await getLatestLicence(state.operator_id, client);
    if (!licence) {
      throw new SetupValidationError("Create PHO licence details before document upload.");
    }

    const now = new Date().toISOString();
    await query(
      `UPDATE operator_licence_documents
          SET is_latest = FALSE,
              superseded_at = $2
        WHERE licence_id = $1
          AND is_latest = TRUE`,
      [licence.id, now],
      client
    );

    await query(
      `INSERT INTO operator_licence_documents
        (id, licence_id, original_filename, mime_type, byte_size, checksum, content, is_latest, uploaded_by_user_id, uploaded_by_user_email, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $10)`,
      [
        randomUUID(),
        licence.id,
        normalizeText(file.originalname) || "licence-document",
        file.mimetype,
        file.size,
        checksumSha256(file.buffer),
        file.buffer,
        actor.userId || null,
        actor.email || null,
        now
      ],
      client
    );

    await query(
      `INSERT INTO operator_licence_history
        (id, licence_id, event_type, actor_user_id, actor_user_email, previous_status, next_status, summary, metadata, occurred_at)
       VALUES ($1, $2, 'document_uploaded', $3, $4, NULL, NULL, $5, $6::jsonb, $7)`,
      [
        randomUUID(),
        licence.id,
        actor.userId || null,
        actor.email || null,
        "PHO licence document uploaded during initial setup.",
        JSON.stringify({
          mimeType: file.mimetype,
          byteSize: file.size
        }),
        now
      ],
      client
    );

    await query(
      `UPDATE system_setup_state
          SET last_edited_at = $2,
              last_edited_by_user_id = $3,
              last_edited_by_user_email = $4
        WHERE setup_key = $1`,
      [INITIAL_SETUP_KEY, now, actor.userId || null, actor.email || null],
      client
    );
    await writeSetupStep("licence_document", actor, client);
    await appendSetupAuditEvent({
      eventName: "operator_licence_document_uploaded",
      actor,
      operatorId: state.operator_id,
      summary: "PHO licence document uploaded.",
      metadata: {
        mimeType: file.mimetype,
        byteSize: file.size
      },
      client
    });
  });
}

async function createOrReuseAuthUserByEmail(
  email: string,
  runner: Queryable
): Promise<{ id: string; email: string }> {
  const normalized = normalizeUserEmail(email);
  const existing = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE lower(email) = $1 LIMIT 1`,
    [normalized],
    runner
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const statusColumn = await describeUserStatusColumn((sql, params) =>
    query(sql, params as unknown[], runner)
  );
  const invitedStatus = resolveInvitedUserStatus(statusColumn);
  const inserted = await query<{ id: string; email: string }>(
    invitedStatus === null
      ? `INSERT INTO users (email) VALUES ($1) RETURNING id, email`
      : `INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id, email`,
    invitedStatus === null ? [normalized] : [normalized, invitedStatus],
    runner
  );
  return inserted.rows[0];
}

async function upsertSystemTestAccount(input: {
  userId: string;
  roleKey: string;
  email: string;
  purpose: string;
  actor: SetupActor;
  client: Queryable;
}): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO system_test_accounts
      (id, user_id, role_key, email_normalized_snapshot, purpose, active, created_by_user_id, created_at, updated_at, deactivated_at, deactivated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $7, NULL, NULL)
     ON CONFLICT (user_id, role_key)
     DO UPDATE SET
       email_normalized_snapshot = EXCLUDED.email_normalized_snapshot,
       purpose = EXCLUDED.purpose,
       active = TRUE,
       updated_at = EXCLUDED.updated_at,
       deactivated_at = NULL,
       deactivated_by_user_id = NULL`,
    [
      randomUUID(),
      input.userId,
      input.roleKey,
      normalizeUserEmail(input.email),
      input.purpose,
      input.actor.userId || null,
      now
    ],
    input.client
  );
}

async function deactivateLegacyPrivilegedTestAccounts(actor: SetupActor, client: Queryable): Promise<void> {
  const roleRows = await query<{ id: number; key: string }>(
    `SELECT id, key FROM roles WHERE key IN ('superuser', 'admin')`,
    [],
    client
  );
  if (roleRows.rows.length === 0) {
    return;
  }

  for (const email of LEGACY_TEST_PRIVILEGED_EMAILS) {
    const userResult = await query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1 LIMIT 1`,
      [normalizeUserEmail(email)],
      client
    );
    const user = userResult.rows[0];
    if (!user) {
      continue;
    }

    await query(
      `DELETE FROM user_roles
        WHERE user_id = $1
          AND role_id = ANY($2::int[])`,
      [user.id, roleRows.rows.map((row) => row.id)],
      client
    );

    const now = new Date().toISOString();
    for (const roleRow of roleRows.rows) {
      await query(
        `INSERT INTO system_test_accounts
          (id, user_id, role_key, email_normalized_snapshot, purpose, active, created_by_user_id, created_at, updated_at, deactivated_at, deactivated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $7, $7, $6)
         ON CONFLICT (user_id, role_key)
         DO UPDATE SET
           active = FALSE,
           updated_at = EXCLUDED.updated_at,
           deactivated_at = EXCLUDED.deactivated_at,
           deactivated_by_user_id = EXCLUDED.deactivated_by_user_id`,
        [
          randomUUID(),
          user.id,
          roleRow.key,
          normalizeUserEmail(email),
          "Deprecated privileged test bootstrap account. Access removed after setup completion.",
          actor.userId || null,
          now
        ],
        client
      );
    }
  }
}

export async function ensureRequiredTestRolesExist(runner?: Queryable): Promise<void> {
  const required = Array.from(new Set(SYSTEM_TEST_ACCOUNT_DEFINITIONS.map((item) => item.roleKey)));
  const result = await query<{ key: string }>(
    `SELECT key FROM roles WHERE key = ANY($1::text[])`,
    [required],
    runner
  );
  const available = new Set(result.rows.map((row) => row.key));
  const missing = required.filter((role) => !available.has(role));
  if (missing.length > 0) {
    throw new MissingAuthRoleError(missing);
  }
}

async function provisionSystemTestAccountsInTransaction(
  actor: SetupActor,
  client: Queryable
): Promise<void> {
  await ensureRequiredTestRolesExist(client);
  const roleRows = await query<{ id: number; key: string }>(
    `SELECT id, key FROM roles WHERE key = ANY($1::text[])`,
    [SYSTEM_TEST_ACCOUNT_DEFINITIONS.map((item) => item.roleKey)],
    client
  );
  const roleByKey = new Map(roleRows.rows.map((row) => [row.key, row.id]));

  for (const account of SYSTEM_TEST_ACCOUNT_DEFINITIONS) {
    const roleId = roleByKey.get(account.roleKey);
    if (!roleId) {
      throw new MissingAuthRoleError([account.roleKey]);
    }

    const user = await createOrReuseAuthUserByEmail(account.email, client);
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, roleId],
      client
    );

    await upsertSystemTestAccount({
      userId: user.id,
      roleKey: account.roleKey,
      email: account.email,
      purpose: account.purpose,
      actor,
      client
    });

    await appendSetupAuditEvent({
      eventName: "test_account_registered",
      actor,
      summary: `System test account ensured for ${account.roleKey}.`,
      metadata: {
        userId: user.id,
        email: normalizeUserEmail(account.email),
        roleKey: account.roleKey
      },
      client
    });
  }

  await deactivateLegacyPrivilegedTestAccounts(actor, client);
}

export async function provisionSystemTestAccounts(actorInput: SetupActor): Promise<void> {
  const actor = normalizeActor(actorInput);
  await withTransaction(async (client) => {
    await provisionSystemTestAccountsInTransaction(actor, client);
  });
}

export async function completeInitialSetup(actorInput: SetupActor): Promise<void> {
  const actor = normalizeActor(actorInput);
  await withTransaction(async (client) => {
    const state = await getSetupStateRow(client);
    if (!state?.operator_id) {
      throw new SetupValidationError("Operator profile is required before setup completion.");
    }
    if (state.status === "completed") {
      return;
    }

    const overview = await getSetupOverview(client);
    if (!overview.bootstrapCompleted) {
      throw new SetupValidationError("Complete superuser bootstrap before setup completion.");
    }
    if (!overview.operator) {
      throw new SetupValidationError("Complete operator profile before setup completion.");
    }
    if (!overview.addresses.registeredPho || !overview.addresses.operational) {
      throw new SetupValidationError("Both registered PHO and operational addresses are required.");
    }
    if (!overview.licence) {
      throw new SetupValidationError("PHO licence details are required.");
    }
    if (!overview.latestDocument) {
      throw new SetupValidationError("PHO licence document is required.");
    }

    await ensureRequiredTestRolesExist(client);
    await provisionSystemTestAccountsInTransaction(actor, client);

    const now = new Date().toISOString();
    await query(
      `UPDATE operators
          SET status = 'active',
              updated_by_user_id = $2,
              updated_by_user_email = $3,
              updated_at = $4
        WHERE id = $1`,
      [state.operator_id, actor.userId || null, actor.email || null, now],
      client
    );

    await query(
      `UPDATE operator_licences
          SET status = 'active',
              updated_by_user_id = $2,
              updated_by_user_email = $3,
              updated_at = $4
        WHERE id = $1`,
      [overview.licence.id, actor.userId || null, actor.email || null, now],
      client
    );

    await query(
      `INSERT INTO operator_licence_history
        (id, licence_id, event_type, actor_user_id, actor_user_email, previous_status, next_status, summary, metadata, occurred_at)
       VALUES ($1, $2, 'status_changed', $3, $4, 'draft', 'active', $5, $6::jsonb, $7)`,
      [
        randomUUID(),
        overview.licence.id,
        actor.userId || null,
        actor.email || null,
        "PHO licence activated after initial setup completion.",
        JSON.stringify({ setupKey: INITIAL_SETUP_KEY }),
        now
      ],
      client
    );

    await query(
      `UPDATE system_setup_state
          SET status = 'completed',
              completed_at = $2,
              completed_by_user_id = $3,
              completed_by_user_email = $4,
              last_edited_at = $2,
              last_edited_by_user_id = $3,
              last_edited_by_user_email = $4
        WHERE setup_key = $1`,
      [INITIAL_SETUP_KEY, now, actor.userId || null, actor.email || null],
      client
    );

    await writeSetupStep("review_confirmation", actor, client);
    await writeSetupStep("completed", actor, client);
    await appendSetupAuditEvent({
      eventName: "initial_setup_completed",
      actor,
      operatorId: state.operator_id,
      summary: "Initial system setup completed and operator activated.",
      metadata: {
        operatorId: state.operator_id
      },
      client
    });
  });
}

export type CleanupTarget = "bookings@romanairporttransfers.co.uk" | "roman.petrlik@hotmail.com";
export const CLEANUP_TARGETS: CleanupTarget[] = [
  "bookings@romanairporttransfers.co.uk",
  "roman.petrlik@hotmail.com"
];

export async function deactivateLegacyOperationalAccounts(
  actorInput: SetupActor,
  targets: CleanupTarget[]
): Promise<void> {
  const actor = normalizeActor(actorInput);
  const normalizedTargets = Array.from(new Set(targets.map((target) => normalizeUserEmail(target))));
  if (normalizedTargets.length === 0) {
    return;
  }

  const overview = await getSetupOverview();
  if (!overview.setupCompleted) {
    throw new SetupValidationError("Legacy account cleanup is available only after setup completion.");
  }

  await withTransaction(async (client) => {
    const roleRows = await query<{ id: number }>(
      `SELECT id FROM roles WHERE key = ANY($1::text[])`,
      [["superuser", "admin", "staff", "tech_support", "driver"]],
      client
    );

    for (const targetEmail of normalizedTargets) {
      const userResult = await query<{ id: string; email: string }>(
        `SELECT id, email FROM users WHERE lower(email) = $1 LIMIT 1`,
        [targetEmail],
        client
      );
      const user = userResult.rows[0];
      if (!user) {
        continue;
      }

      if (roleRows.rows.length > 0) {
        await query(
          `DELETE FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::int[])`,
          [user.id, roleRows.rows.map((row) => row.id)],
          client
        );
      }

      await appendSetupAuditEvent({
        eventName: "legacy_account_cleanup_deactivated",
        actor,
        summary: `Legacy operational account deactivated for setup cleanup: ${targetEmail}.`,
        metadata: {
          userId: user.id,
          email: targetEmail
        },
        client
      });
    }
  });
}

export async function isActiveRegisteredTestAccountByEmail(email: string): Promise<boolean> {
  const normalized = normalizeUserEmail(email);
  if (!normalized) {
    return false;
  }
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM system_test_accounts
       WHERE email_normalized_snapshot = $1
         AND active = TRUE
     ) AS exists`,
    [normalized]
  );
  return Boolean(result.rows[0]?.exists);
}

export function isTestSinkEnabled(): boolean {
  const mode = normalizeText(process.env.TEST_NOTIFICATION_SINK_MODE || "").toLowerCase();
  return mode === "mailpit" || mode === "internal";
}

export async function assertSafeNotificationSinkForTestEmail(email: string): Promise<void> {
  const isTestAccount = await isActiveRegisteredTestAccountByEmail(email);
  if (isTestAccount && !isTestSinkEnabled()) {
    throw new SetupValidationError(
      "Test-account notification sink is not configured. Set TEST_NOTIFICATION_SINK_MODE=mailpit (or internal) before requesting access codes for test accounts."
    );
  }
}

export async function listSetupAuditEvents(limit = 100): Promise<
  Array<{
    occurredAt: string;
    eventName: string;
    actorUserEmail: string | null;
    summary: string;
  }>
> {
  const result = await query<{
    occurred_at: string;
    event_name: string;
    actor_user_email: string | null;
    summary: string;
  }>(
    `SELECT occurred_at, event_name, actor_user_email, summary
       FROM system_setup_audit_events
      ORDER BY occurred_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(500, limit))]
  );

  return result.rows.map((row) => ({
    occurredAt: row.occurred_at,
    eventName: row.event_name,
    actorUserEmail: row.actor_user_email,
    summary: row.summary
  }));
}
