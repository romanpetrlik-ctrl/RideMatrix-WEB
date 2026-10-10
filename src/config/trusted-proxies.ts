import type { Application } from "express";

const IP_ADDRESS_OR_CIDR = /^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/;

export function configureTrustedProxies(app: Application, configuredAddresses?: string): void {
  const value = configuredAddresses?.trim();

  if (!value) {
    app.set("trust proxy", false);
    return;
  }

  const addresses = value.split(",").map((address) => address.trim());
  if (addresses.some((address) => !IP_ADDRESS_OR_CIDR.test(address))) {
    throw new Error("TRUSTED_PROXY_IPS must contain only comma-separated IP addresses or CIDR ranges.");
  }

  app.set("trust proxy", addresses);
}
