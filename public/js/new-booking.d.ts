type CargoCounts = Record<"adults" | "children" | "sportsEquipment" | "xlBaggage" | "lBaggage" | "cabinHandBags" | "backpacks", number>;
type ViaState = { via1: boolean; via2: boolean };
type RouteLike = {
  status: string;
  message?: string;
  distanceMiles?: string;
  durationSeconds?: number;
  tollsReported?: boolean;
  zones?: Array<{ label: string }>;
} | null;
type PriceLike = {
  status: string;
  total: string | null;
  lines: Array<{ type: string; label: string; status: string; amount: string | null; basis: string }>;
} | null;

declare const newBooking: {
  cargoSummary(counts: CargoCounts, childSeat: boolean, booster: boolean): string;
  passengerState(
    manager: { name: string; phone: string },
    passenger: { name: string; phone: string },
    passengerIsManager: boolean
  ): { name: string; phone: string; readOnly: boolean };
  formatDuration(seconds: number): string;
  activeStopKeys(viaActive: ViaState): string[];
  nextViaToAdd(viaActive: ViaState): "via1" | "via2" | null;
  removeVia(viaActive: ViaState, key: "via1" | "via2"): ViaState & { shiftVia2IntoVia1: boolean };
  routeSummary(route: RouteLike): { distance: string; duration: string; charges: string; message: string };
  priceBreakdownHtml(price: PriceLike): string;
  init(doc: Document): void;
};

export default newBooking;
