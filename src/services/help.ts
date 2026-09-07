export type HelpContent = {
  key: string;
  title: string;
  body: string;
};

export const HELP_REGISTRY: Record<string, HelpContent> = {
  "vehicle.classAssignment": {
    key: "vehicle.classAssignment",
    title: "Vehicle class assignment",
    body: "Select every service class this vehicle can operate. A vehicle may belong to more than one class."
  },
  "vehicle.fuelType": {
    key: "vehicle.fuelType",
    title: "Fuel type",
    body: "Choose ICE, HYBRID, or EV so operational filters and reporting can identify the vehicle powertrain."
  },
  "vehicle.passengerCapacity": {
    key: "vehicle.passengerCapacity",
    title: "Passenger capacity",
    body: "Enter the maximum number of passengers the vehicle can legally carry. The value must be a positive whole number."
  },
  "vehicle.luggageCapacity": {
    key: "vehicle.luggageCapacity",
    title: "Luggage capacity",
    body: "Record the maximum number of each baggage category this specific vehicle can carry. Zero is valid when a category is unsupported."
  },
  "vehicle.wheelchairAccessible": {
    key: "vehicle.wheelchairAccessible",
    title: "Wheelchair accessibility",
    body: "Use this for vehicles assigned to the Wheelchair Accessible class. The operational flag is kept in sync with that class."
  },
  "vehicle.registeredKeeper": {
    key: "vehicle.registeredKeeper",
    title: "Registered keeper",
    body: "Store concise registered keeper details separately from the linked driver. Do not use this as a driver assignment."
  },
  "vehicle.linkedDriver": {
    key: "vehicle.linkedDriver",
    title: "Linked driver",
    body: "Assign the current primary driver for this vehicle. A driver may be linked to multiple vehicles and assignment history is preserved."
  },
  "vehicle.mec": {
    key: "vehicle.mec",
    title: "MEC",
    body: "Track the Medical Exemption Certificate compliance document and its expiry date where one is required."
  },
  "vehicle.hackneyPhBadge": {
    key: "vehicle.hackneyPhBadge",
    title: "Hackney / PH badge",
    body: "Track the Hackney carriage or private hire badge document and expiry status."
  },
  "baggage.xlSuitcase": {
    key: "baggage.xlSuitcase",
    title: "XL suitcase",
    body: "Large suitcase category with a reference weight from 31 kg upward."
  },
  "baggage.lSuitcase": {
    key: "baggage.lSuitcase",
    title: "L suitcase",
    body: "Large suitcase category with a reference maximum weight of 23 kg."
  },
  "baggage.cabinBag": {
    key: "baggage.cabinBag",
    title: "CB cabin bag",
    body: "Cabin bag category with a reference maximum weight of 12 kg."
  },
  "baggage.backpack": {
    key: "baggage.backpack",
    title: "BP backpack",
    body: "Backpack category with a reference maximum weight of 8 kg."
  }
};

export function resolveHelpContent(key: string): HelpContent {
  return HELP_REGISTRY[key] || {
    key,
    title: "Help unavailable",
    body: "Help content is not available for this field yet."
  };
}
