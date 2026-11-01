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

export const londonFeeScheduleDrafts: Record<LondonFeeScheduleDraft["scheme"], LondonFeeScheduleDraft> = {
  "london-ulez": {
    scheme: "london-ulez",
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
