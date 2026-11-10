((root, createCalculator) => {
  const calculateDistanceSlabFare = createCalculator();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = calculateDistanceSlabFare;
  } else {
    root.calculateDistanceSlabFare = calculateDistanceSlabFare;
  }
})(globalThis, () => {
  const parseDecimal = (value) => {
    if (typeof value !== "string" || value.length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
    const [whole = "0", fraction = ""] = value.startsWith(".")
      ? ["0", value.slice(1)]
      : value.split(".");
    return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
  };

  const compareDecimals = (left, right) => {
    const scale = Math.max(left.scale, right.scale);
    const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
    const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  };

  return (slabs, distanceMiles) => {
    const distance = parseDecimal(distanceMiles);
    if (!Array.isArray(slabs) || slabs.length === 0 || !distance) {
      throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
    }

    const values = slabs.map((slab) => ({
      start: parseDecimal(slab.startMiles),
      endText: slab.endMiles,
      end: slab.endMiles === "" ? null : parseDecimal(slab.endMiles),
      rate: parseDecimal(slab.ratePerMile)
    }));
    if (!values[0].start || values[0].start.coefficient !== 0n) {
      throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
    }
    values.forEach((slab, index) => {
      const finalSlab = index === values.length - 1;
      if (!slab.start || !slab.rate || (finalSlab ? slab.endText !== "" : !slab.end) ||
          (slab.end && compareDecimals(slab.end, slab.start) <= 0)) {
        throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
      }
      if (index > 0) {
        const previousEnd = values[index - 1].end;
        if (!previousEnd || compareDecimals(previousEnd, slab.start) !== 0) {
          throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
        }
      }
    });

    const products = [];
    for (const slab of values) {
      if (compareDecimals(distance, slab.start) <= 0) continue;
      const portionEnd = slab.end && compareDecimals(distance, slab.end) < 0
        ? distance
        : slab.end ?? distance;
      const scale = Math.max(slab.start.scale, portionEnd.scale);
      const portion = portionEnd.coefficient * 10n ** BigInt(scale - portionEnd.scale) -
        slab.start.coefficient * 10n ** BigInt(scale - slab.start.scale);
      if (portion > 0n) products.push({ coefficient: portion * slab.rate.coefficient, scale: scale + slab.rate.scale });
    }
    const totalScale = Math.max(0, ...products.map((product) => product.scale));
    const total = products.reduce(
      (sum, product) => sum + product.coefficient * 10n ** BigInt(totalScale - product.scale),
      0n
    );
    const pennyScale = totalScale - 2;
    const pennies = pennyScale <= 0
      ? total * 10n ** BigInt(-pennyScale)
      : (() => {
        const divisor = 10n ** BigInt(pennyScale);
        const quotient = total / divisor;
        return total % divisor * 2n >= divisor ? quotient + 1n : quotient;
      })();
    return `${pennies / 100n}.${String(pennies % 100n).padStart(2, "0")}`;
  };
});
