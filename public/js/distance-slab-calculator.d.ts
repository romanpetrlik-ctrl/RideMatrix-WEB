type DistanceSlabForPreview = {
  startMiles: string;
  endMiles: string;
  ratePerMile: string;
};

declare const calculateDistanceSlabFare: (
  slabs: DistanceSlabForPreview[],
  distanceMiles: string
) => string;

export default calculateDistanceSlabFare;
