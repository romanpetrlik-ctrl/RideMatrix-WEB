(() => {
  const form = document.querySelector("[data-location-discount-form]");
  if (!form) return;

  // Mirrors the server-side UK postcode rules in src/services/fare-settings.ts.
  const outwardPattern = /^(?:[A-PR-UWYZ](?:[0-9]{1,2}|[A-HK-Y][0-9]{1,2}|[0-9][A-HJKPSTUW]|[A-HK-Y][0-9][ABEHMNPRVWXY]))$/;
  const fullPattern = /^(?:GIR0AA|(?:[A-PR-UWYZ](?:[0-9]{1,2}|[A-HK-Y][0-9]{1,2}|[0-9][A-HJKPSTUW]|[A-HK-Y][0-9][ABEHMNPRVWXY]))[0-9][ABDEFGHJLNPQRSTUWXYZ]{2})$/;
  const maxEntries = 500;

  const normalize = (value, precision) => {
    const compact = value.trim().toUpperCase().replace(/\s+/g, "");
    if (precision === "outward") return outwardPattern.test(compact) ? compact : null;
    return fullPattern.test(compact) ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : null;
  };

  const validDate = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };

  const field = (name) => form.elements.namedItem(name);
  const selected = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value ?? "";

  const setError = (key, message) => {
    const error = form.querySelector(`[data-discount-error="${key}"]`);
    if (error) {
      error.textContent = message;
      error.classList.toggle("fare-settings__field-error--invalid", Boolean(message));
      if (message) error.setAttribute("role", "alert");
      else error.removeAttribute("role");
    }
    const control = field(key);
    const controls = control instanceof RadioNodeList ? Array.from(control) : control ? [control] : [];
    controls.forEach((input) => input.setAttribute("aria-invalid", message ? "true" : "false"));
  };

  const validate = () => {
    const errors = {};
    const name = field("name").value.trim();
    if (!name || name.length > 160) errors.name = "Enter a rule name or description no longer than 160 characters.";

    if (!field("locationKey").value) errors.locationKey = "Select a managed airport or POI.";

    const precision = selected("postcodePrecision");
    if (precision !== "full" && precision !== "outward") {
      errors.postcodePrecision = "Choose whether the entries are full postcodes or outward codes.";
    }

    const entries = field("postcodes").value.split(/[\n\r,;]+/).map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) {
      errors.postcodes = "Enter at least one UK postcode entry.";
    } else if (entries.length > maxEntries) {
      errors.postcodes = `Enter no more than ${maxEntries} postcode entries.`;
    } else if (!errors.postcodePrecision) {
      const seen = new Set();
      const invalid = [];
      const duplicates = [];
      entries.forEach((entry) => {
        const normalized = normalize(entry, precision);
        if (!normalized) {
          if (precision === "full" && normalize(entry, "outward")) {
            invalid.push(`${entry} is an outward code, not a full postcode; choose Outward code precision to match the whole area`);
          } else if (precision === "outward" && normalize(entry, "full")) {
            invalid.push(`${entry} is a full postcode, not an outward code; choose Full postcode precision for exact postcodes`);
          } else {
            invalid.push(`${entry} is not a valid UK ${precision === "full" ? "full postcode" : "outward code"}`);
          }
        } else if (seen.has(normalized)) {
          if (!duplicates.includes(normalized)) duplicates.push(normalized);
        } else {
          seen.add(normalized);
        }
      });
      if (invalid.length) {
        errors.postcodes = `${invalid.slice(0, 5).join("; ")}${invalid.length > 5 ? `; and ${invalid.length - 5} more` : ""}.`;
      } else if (duplicates.length) {
        errors.postcodes = `Remove duplicate postcode entries: ${duplicates.join(", ")}.`;
      }
    }

    const percentage = field("discountPercentage").value.trim();
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(percentage) || Number(percentage) <= 0 || Number(percentage) > 100) {
      errors.discountPercentage = "Enter a percentage greater than 0 and no more than 100, with up to 2 decimal places.";
    }

    const startDate = field("startDate").value.trim();
    const endDate = field("endDate").value.trim();
    if (startDate && !validDate(startDate)) errors.startDate = "Enter a valid start date or leave it blank.";
    if (endDate && !validDate(endDate)) errors.endDate = "Enter a valid end date or leave it blank.";
    if (!errors.startDate && !errors.endDate && startDate && endDate && endDate < startDate) {
      errors.endDate = "The end date cannot be before the start date.";
    }

    const enabled = selected("enabled");
    if (enabled !== "yes" && enabled !== "no") errors.enabled = "Choose whether this rule is enabled or disabled.";
    return errors;
  };

  const keys = ["name", "locationKey", "postcodePrecision", "postcodes", "discountPercentage", "startDate", "endDate", "enabled"];

  form.addEventListener("submit", (event) => {
    const errors = validate();
    keys.forEach((key) => setError(key, errors[key] ?? ""));
    const firstInvalid = keys.find((key) => errors[key]);
    if (!firstInvalid) return;
    event.preventDefault();
    const control = field(firstInvalid);
    (control instanceof RadioNodeList ? control[0] : control)?.focus();
  });

  form.addEventListener("input", (event) => {
    const key = event.target?.name;
    if (key && keys.includes(key)) setError(key, "");
  });
})();
