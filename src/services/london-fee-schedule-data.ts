// Shared by the initial database migration and the draft editor.
export type LondonFeeRateDraft = {
  key: string;
  label: string;
  amount: number;
  currency: "GBP";
  chargingPeriod: string;
  applicability: string;
  emissionsThresholds: string;
};

export type LondonFeeScheduleDraft = {
  scheme: "london-lez" | "london-ulez";
  kind: "london_daily";
  title: string;
  status: "draft_inactive";
  active: false;
  bookingPriceUsage: "never";
  chargingPeriod: string;
  operatingRules: string[];
  discountAndExemptionRulesStatus: "unknown_unverified";
  effectiveDate: null;
  effectiveDateStatus: "unknown_unverified";
  provenance: string;
  sources: Array<{ label: string; url: string | null }>;
  rates: LondonFeeRateDraft[];
  nonChargeableCategories: Array<{ label: string; applicability: string; emissionsThresholds: string }>;
};

export type CrossingFeeRateDraft = {
  key: string;
  label: string;
  amount: string;
  currency: "GBP";
  vehicleClass: string;
  paymentMethod: string;
  chargingPeriod: string;
  applicability: string;
  crossingBasis: string;
};

export type CrossingFeeScheduleDraft = {
  scheme: "dartford-crossing" | "blackwall-silvertown-tunnels";
  kind: "crossing";
  title: string;
  status: "draft_inactive";
  active: false;
  bookingPriceUsage: "never";
  allowZeroAmounts: boolean;
  chargingPeriod: string;
  operatingRules: string[];
  discountAndExemptionRulesStatus: "unknown_unverified";
  effectiveDate: null;
  effectiveDateStatus: "unknown_unverified";
  provenance: string;
  sources: Array<{ label: string; url: string | null }>;
  rates: CrossingFeeRateDraft[];
  eligibilityNotes: string[];
};

export type FeeScheduleDraft = LondonFeeScheduleDraft | CrossingFeeScheduleDraft;

const crossingRate = (
  key: string,
  label: string,
  amount: string,
  vehicleClass: string,
  paymentMethod: string,
  chargingPeriod: string,
  applicability: string,
  crossingBasis: string
): CrossingFeeRateDraft => ({
  key,
  label,
  amount,
  currency: "GBP",
  vehicleClass,
  paymentMethod,
  chargingPeriod,
  applicability,
  crossingBasis
});

const dartfordRates: CrossingFeeRateDraft[] = [
  ...(["A", "B", "C", "D"] as const).flatMap((vehicleClass, index) => {
    const labels = [
      "Motorcycles, mopeds and quad bikes",
      "Cars (including trailers), motorhomes and minibuses with 9 or fewer seats including the driver",
      "Vehicles with 2 axles",
      "Vehicles with more than 2 axles"
    ];
    const amounts = [
      ["0.00", "0.00", "0.00"],
      ["3.50", "3.50", "2.80"],
      ["4.20", "4.20", "3.60"],
      ["8.40", "8.40", "7.20"]
    ][index];
    return [
      crossingRate(`dartford-${vehicleClass.toLowerCase()}-one-off`, labels[index], amounts[0], `Class ${vehicleClass}`, "One-off payment", "06:00–22:00 UK local time, every day", labels[index], "Per individual crossing"),
      crossingRate(`dartford-${vehicleClass.toLowerCase()}-payg`, labels[index], amounts[1], `Class ${vehicleClass}`, "Pay as you go", "06:00–22:00 UK local time, every day", labels[index], "Per individual crossing"),
      crossingRate(`dartford-${vehicleClass.toLowerCase()}-prepay`, labels[index], amounts[2], `Class ${vehicleClass}`, "Pre-pay", "06:00–22:00 UK local time, every day", labels[index], "Per individual crossing")
    ];
  })
];

const tunnelRates: CrossingFeeRateDraft[] = [
  {
    vehicleClass: "Motorcycles, mopeds, motor tricycles",
    label: "Motorcycles, mopeds, motor tricycles",
    offPeak: "1.55",
    peak: "2.60"
  },
  { vehicleClass: "Cars and small vans", label: "Cars and small vans", offPeak: "1.55", peak: "4.20" },
  { vehicleClass: "Large vans", label: "Large vans", offPeak: "2.60", peak: "6.80" },
  { vehicleClass: "Heavy goods vehicles", label: "Heavy goods vehicles", offPeak: "5.25", peak: "10.50" }
].flatMap(({ vehicleClass, label, offPeak, peak }) => [
  crossingRate(
    `tunnel-${vehicleClass.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-autopay-offpeak`,
    label,
    offPeak,
    vehicleClass,
    "Auto Pay off-peak",
    "Chargeable off-peak times: outside weekday direction-specific peaks and throughout weekends",
    vehicleClass,
    "Per individual crossing in either direction"
  ),
  crossingRate(
    `tunnel-${vehicleClass.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-autopay-peak`,
    label,
    peak,
    vehicleClass,
    "Auto Pay peak",
    "Weekdays: northbound 06:00–10:00; southbound 16:00–19:00",
    vehicleClass,
    "Per individual crossing in either direction"
  ),
  crossingRate(
    `tunnel-${vehicleClass.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-phone-online`,
    label,
    peak,
    vehicleClass,
    "Phone/online",
    "All chargeable times: 06:00–22:00 UK local time, every day except Christmas Day",
    vehicleClass,
    "Per individual crossing in either direction"
  )
]);

export const londonFeeScheduleDrafts: Record<LondonFeeScheduleDraft["scheme"], LondonFeeScheduleDraft> = {
  "london-ulez": {
    scheme: "london-ulez",
    kind: "london_daily",
    title: "London ULEZ",
    status: "draft_inactive",
    active: false,
    bookingPriceUsage: "never",
    chargingPeriod: "Per charging day, midnight to midnight.",
    operatingRules: [
      "Operates 24 hours a day every day except Christmas Day (25 December).",
      "Applies across London boroughs and does not include the M25.",
      "The daily charge applies only to a chargeable vehicle that does not meet its applicable emissions standard and is not exempt.",
      "The ULEZ charge is separate from other applicable schemes.",
      "Non-UK-registered vehicles are subject to the same standards and charge. TfL registration is an operational requirement, not a fee or proof of exemption."
    ],
    discountAndExemptionRulesStatus: "unknown_unverified",
    effectiveDate: null,
    effectiveDateStatus: "unknown_unverified",
    provenance: "Based on the TfL vehicle-category and operating-rule excerpts supplied for this draft. Effective date and complete discount/exemption rules were not supplied or verified.",
    sources: [
      { label: "Cars", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/cars?intcmp=52215" },
      { label: "Vans, minibuses and more", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/vans-minibuses-and-more?intcmp=52212" },
      { label: "Motorcycles, mopeds and more", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/motorcycles-mopeds-and-more?intcmp=52209" },
      { label: "Larger vehicles", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/larger-vehicles?intcmp=52206" }
    ],
    rates: [
      {
        key: "ulez-cars",
        label: "Cars",
        amount: 12.5,
        currency: "GBP",
        chargingPeriod: "Per charging day, midnight to midnight.",
        applicability: "Cars in a chargeable category that do not meet the applicable standard and are not exempt.",
        emissionsThresholds: "Petrol: Euro 4 (NOx). Diesel: Euro 6 (NOx and PM)."
      },
      {
        key: "ulez-vans-specialist-minibuses",
        label: "Vans, specialist vehicles and minibuses",
        amount: 12.5,
        currency: "GBP",
        chargingPeriod: "Per charging day, midnight to midnight.",
        applicability: "Small vans up to and including 1.205 tonnes unladen; larger vans/specialist vehicles over 1.205 tonnes unladen up to and including 3.5 tonnes GVW; listed specialist vehicles 2.5–3.5 tonnes GVW; and minibuses with more than 8 passenger seats up to 5 tonnes GVW, when chargeable and not exempt.",
        emissionsThresholds: "Petrol: Euro 4 (NOx). Diesel: Euro 6 (NOx and PM)."
      },
      {
        key: "ulez-motorcycles-and-l-category",
        label: "Motorcycles, mopeds, motorised tricycles and L-category quadricycles",
        amount: 12.5,
        currency: "GBP",
        chargingPeriod: "Per charging day, midnight to midnight.",
        applicability: "These vehicles in a chargeable category that do not meet the applicable standard and are not exempt.",
        emissionsThresholds: "Euro 3 (NOx)."
      }
    ],
    nonChargeableCategories: [
      {
        label: "Vehicles over 3.5 tonnes GVW and buses, minibuses or coaches over 5 tonnes GVW",
        applicability: "Do not pay the daily ULEZ charge under the supplied text; they may instead be subject to LEZ.",
        emissionsThresholds: "ULEZ daily charge does not apply to these weight categories."
      }
    ]
  },
  "london-lez": {
    scheme: "london-lez",
    kind: "london_daily",
    title: "London LEZ",
    status: "draft_inactive",
    active: false,
    bookingPriceUsage: "never",
    chargingPeriod: "Per charging day, midnight to midnight, every day of the year.",
    operatingRules: [
      "LEZ charging days run midnight to midnight, every day of the year."
    ],
    discountAndExemptionRulesStatus: "unknown_unverified",
    effectiveDate: null,
    effectiveDateStatus: "unknown_unverified",
    provenance: "Based on the TfL “How to pay a LEZ charge” excerpt supplied for this draft. The source URL was not supplied; effective date and complete discount/exemption rules were not supplied or verified.",
    sources: [
      { label: "TfL “How to pay a LEZ charge” excerpt supplied by the operator; source URL not provided", url: null }
    ],
    rates: [
      {
        key: "lez-vans-specialist-minibuses",
        label: "Vans, specialist diesel vehicles and minibuses up to 5 tonnes",
        amount: 100,
        currency: "GBP",
        chargingPeriod: "Per charging day, midnight to midnight.",
        applicability: "Vans or specialist diesel vehicles over 1.205 tonnes unladen up to 3.5 tonnes GVW, and minibuses up to 5 tonnes, when they do not meet the standard.",
        emissionsThresholds: "Euro 3."
      },
      {
        key: "lez-heavy-euro-iv-pm",
        label: "Heavy vehicles and larger buses that meet Euro IV (PM) but not Euro VI",
        amount: 100,
        currency: "GBP",
        chargingPeriod: "Per charging day, midnight to midnight.",
        applicability: "Vehicles over 3.5 tonnes GVW and buses, minibuses or coaches over 5 tonnes GVW that do not meet Euro VI but meet Euro IV for PM.",
        emissionsThresholds: "Does not meet Euro VI (NOx and PM); meets Euro IV (PM)."
      },
      {
        key: "lez-heavy-below-euro-iv-pm",
        label: "Heavy vehicles and larger buses that do not meet Euro IV (PM)",
        amount: 300,
        currency: "GBP",
        chargingPeriod: "Per charging day, midnight to midnight.",
        applicability: "Vehicles over 3.5 tonnes GVW and buses, minibuses or coaches over 5 tonnes GVW that do not meet Euro IV for PM.",
        emissionsThresholds: "Does not meet Euro IV (PM)."
      }
    ],
    nonChargeableCategories: [
      {
        label: "Cars and motorcycles/L-category vehicles",
        applicability: "Not subject to LEZ under the supplied text.",
        emissionsThresholds: "Not applicable."
      },
      {
        label: "Small vans up to and including 1.205 tonnes unladen",
        applicability: "Not subject to LEZ under the supplied TfL vehicle-category text.",
        emissionsThresholds: "Not applicable."
      }
    ]
  }
};

export const crossingFeeScheduleDrafts: Record<CrossingFeeScheduleDraft["scheme"], CrossingFeeScheduleDraft> = {
  "dartford-crossing": {
    scheme: "dartford-crossing",
    kind: "crossing",
    title: "Dartford Crossing",
    status: "draft_inactive",
    active: false,
    bookingPriceUsage: "never",
    allowZeroAmounts: true,
    chargingPeriod: "06:00–22:00 UK local time every day, including weekends and bank holidays; crossings from 22:00–06:00 are free.",
    operatingRules: [
      "Charge one fee per individual crossing.",
      "Crossings are free from 22:00 to 06:00 UK local time.",
      "Count droppable axles whether raised or lowered. For articulated vehicles, count trailer axles only."
    ],
    discountAndExemptionRulesStatus: "unknown_unverified",
    effectiveDate: null,
    effectiveDateStatus: "unknown_unverified",
    provenance: "Rates and rules transcribed from the supplied GOV.UK charges page. No effective date or verification date was supplied.",
    sources: [
      { label: "Pay the Dartford Crossing charge: charges", url: "https://www.gov.uk/pay-dartford-crossing-charge/charges" }
    ],
    rates: dartfordRates,
    eligibilityNotes: [
      "A vehicle with free UK vehicle tax because of disability does not need to pay; the vehicle is checked automatically. Eligibility is not resolved here.",
      "Dartford/Thurrock residents may qualify for account-based annual discounts: £25 for unlimited crossings or £12.50 for 50 crossings, with supplied top-up/upgrade rules. Eligibility and discounts are not automatically applied.",
      "The specific top-up/upgrade terms were not provided here and are not assumed."
    ]
  },
  "blackwall-silvertown-tunnels": {
    scheme: "blackwall-silvertown-tunnels",
    kind: "crossing",
    title: "Blackwall and Silvertown tunnels",
    status: "draft_inactive",
    active: false,
    bookingPriceUsage: "never",
    allowZeroAmounts: false,
    chargingPeriod: "06:00–22:00 UK local time every day except Christmas Day (25 December); crossings from 22:00–06:00 are free.",
    operatingRules: [
      "One shared charging schedule covers Blackwall and Silvertown tunnels; each crossing must retain its actual tunnel identity (Blackwall or Silvertown).",
      "The fee is per crossing, in either direction.",
      "Weekday peak periods are northbound 06:00–10:00 and southbound 16:00–19:00. Off-peak applies at other chargeable times and throughout weekends.",
      "Off-peak rates are available only with Auto Pay. Without Auto Pay, the peak/phone-or-online rate applies at all chargeable times.",
      "Whether weekday peak periods apply on Monday–Friday bank holidays is unresolved and is not assumed."
    ],
    discountAndExemptionRulesStatus: "unknown_unverified",
    effectiveDate: null,
    effectiveDateStatus: "unknown_unverified",
    provenance: "Rates and rules were supplied as TfL text and a rate-table image. No source URL, licence, verification date, or effective date was supplied.",
    sources: [
      { label: "TfL text and rate-table image supplied; source URL not provided", url: null }
    ],
    rates: tunnelRates,
    eligibilityNotes: [
      "Eligible residents on certain benefits, sole traders, small businesses and charities may qualify for discounts; some vehicles may be exempt or receive 100% discount. Eligibility and discount rules are not resolved or automatically applied.",
      "No weight or size threshold is supplied for small vans or large vans. Vehicle-category mapping is unresolved and is not inferred."
    ]
  }
};
