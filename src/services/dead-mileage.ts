import { query } from "../database/connection";

/** Mean Earth radius convention shared by every operational-base radius rule. */
export const EARTH_RADIUS_MILES = 6_371_008.8 / 1609.344;

export type GeoPoint = { latitude: number; longitude: number };

export type OperationalBase = {
  operatorId: string;
  latitude: number | null;
  longitude: number | null;
  providerPlaceId: string | null;
  coordinatesVerified: boolean;
  updatedAt: string | null;
};

export function validPoint(point: GeoPoint): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
    point.latitude >= -90 && point.latitude <= 90 &&
    point.longitude >= -180 && point.longitude <= 180;
}

export function isOperationalBaseVerified(base: OperationalBase | null): boolean {
  return Boolean(base?.coordinatesVerified && validPoint({
    latitude: base.latitude ?? NaN,
    longitude: base.longitude ?? NaN
  }) && base.providerPlaceId && base.updatedAt);
}

export async function getOperationalBase(): Promise<OperationalBase | null> {
  const result = await query<{
    operator_id: string;
    latitude: string | number | null;
    longitude: string | number | null;
    provider_place_id: string | null;
    coordinates_verified: boolean;
    updated_at: string | Date;
  }>(
    `SELECT address.operator_id, address.latitude, address.longitude,
            address.provider_place_id, address.coordinates_verified, address.updated_at
       FROM operator_addresses address
       JOIN system_setup_state setup ON setup.operator_id = address.operator_id
      WHERE setup.setup_key = 'initial_system_setup'
        AND address.address_type = 'operational'
      LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    operatorId: row.operator_id,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    providerPlaceId: row.provider_place_id,
    coordinatesVerified: row.coordinates_verified,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}
