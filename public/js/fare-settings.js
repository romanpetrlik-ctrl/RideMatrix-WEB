(() => {
  const dailyDetails = document.querySelector("[data-fare-settings-details]");
  const dailyRadios = document.querySelectorAll('input[name="dailyEnabled"]');
  const bankHolidayRadios = document.querySelectorAll('input[name="bankHolidayEnabled"]');
  const periodList = document.querySelector("[data-period-list]");
  const periodTemplate = document.querySelector("#fare-settings-period-template");
  const addPeriodButton = document.querySelector("[data-add-period]");
  const distanceForm = document.querySelector("[data-distance-slab-form]");
  const slabList = document.querySelector("[data-distance-slab-list]");
  const slabTemplate = document.querySelector("#fare-settings-distance-slab-template");
  const addSlabButton = document.querySelector("[data-add-distance-slab]");
  const testDistance = document.querySelector("[data-test-distance]");
  const previewTotal = document.querySelector("[data-distance-preview-total]");
  const previewError = document.querySelector("#distance-test-error");
  const addSlabError = document.querySelector("[data-add-distance-slab-error]");
  if (!dailyDetails && !periodList && !distanceForm) return;

  const selectedValue = (radios) => Array.from(radios).find((radio) => radio.checked)?.value;

  const updateDailyFields = () => {
    if (!dailyDetails) return;
    const enabled = selectedValue(dailyRadios) === "yes";
    dailyDetails.dataset.enabled = String(enabled);
    dailyDetails.querySelectorAll("input").forEach((input) => {
      input.disabled = !enabled;
      input.required = enabled;
    });
  };

  const updatePeriodFields = () => {
    const enabled = selectedValue(bankHolidayRadios) === "yes";
    periodList?.querySelectorAll("[data-period] input").forEach((input) => {
      input.required = enabled;
    });
  };

  const reindexPeriods = () => {
    if (!periodList) return;
    Array.from(periodList.querySelectorAll("[data-period]")).forEach((period, index) => {
      period.dataset.index = String(index);
      period.querySelector("legend").textContent = `Period ${index + 1}`;
      period.querySelector("legend").id = `bank-period-${index}-title`;
      period.setAttribute("aria-labelledby", `bank-period-${index}-title`);
      period.querySelectorAll(".fare-settings__field").forEach((field) => {
        const input = field.querySelector("input");
        const label = field.querySelector("label");
        const error = field.querySelector(".fare-settings__field-error");
        const fieldName = input.name.match(/\[([^\]]+)\]$/)?.[1];
        if (!fieldName) return;
        input.name = `periods[${index}][${fieldName}]`;
        input.id = `bank-period-${index}-${fieldName === "startDateTime" ? "start" : fieldName === "endDateTime" ? "end" : fieldName === "percentage" ? "percentage" : "label"}`;
        label.htmlFor = input.id;
        error.id = `${input.id}-error`;
        input.setAttribute("aria-describedby", error.id);
      });
      period.querySelector("[data-remove-period]").textContent = `Remove period ${index + 1}`;
    });
    updatePeriodFields();
  };

  const reindexSlabs = () => {
    if (!slabList) return;
    const slabs = Array.from(slabList.querySelectorAll("[data-distance-slab]"));
    slabs.forEach((slab, index) => {
      const finalSlab = index === slabs.length - 1;
      const endInput = slab.querySelector('input[name$="[endMiles]"]');
      const openEndedFinalSlab = finalSlab && endInput.value.trim() === "";
      const title = slab.querySelector("[data-slab-title]");
      title.id = `distance-slab-${index}-title`;
      title.textContent = `Slab ${index + 1}${openEndedFinalSlab ? " — open-ended final slab" : ""}`;
      slab.dataset.index = String(index);
      slab.setAttribute("aria-labelledby", title.id);
      slab.querySelectorAll(".fare-settings__field").forEach((field) => {
        const input = field.querySelector("input");
        const label = field.querySelector("label");
        const fieldName = input.name.match(/\[([^\]]+)\]$/)?.[1];
        if (!fieldName) return;
        const suffix = fieldName === "startMiles" ? "start" : fieldName === "endMiles" ? "end" : "rate";
        const inputId = `distance-slab-${index}-${suffix}`;
        input.name = `distanceSlabs[${index}][${fieldName}]`;
        input.id = inputId;
        label.htmlFor = inputId;
        const error = field.querySelector(".fare-settings__field-error");
        if (error) {
          error.id = `${inputId}-error`;
        }
        if (fieldName === "endMiles") {
          const note = field.querySelector("[data-open-ended-note]");
          if (note) {
            note.id = `${inputId}-help`;
            note.hidden = !openEndedFinalSlab;
          }
          input.placeholder = openEndedFinalSlab ? "Open-ended" : "";
          input.setAttribute("aria-label", `End distance in miles${openEndedFinalSlab ? "; leave blank for open-ended final slab" : ""}`);
          input.setAttribute("aria-describedby", `${inputId}-help ${inputId}-error`);
        } else {
          input.setAttribute("aria-describedby", `${inputId}-error`);
        }
      });
      const removeButton = slab.querySelector("[data-remove-distance-slab]");
      removeButton.setAttribute("aria-label", `Remove slab ${index + 1}`);
    });
  };

  const parseSlabDistance = (value) => {
    const trimmed = value.trim();
    if (trimmed.length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
    const [whole, fraction = ""] = trimmed.split(".");
    return { text: trimmed, coefficient: BigInt(`${whole || "0"}${fraction}`), scale: fraction.length };
  };

  const compareSlabDistances = (left, right) => {
    const scale = Math.max(left.scale, right.scale);
    const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
    const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  };

  const calculatePreview = () => {
    if (!slabList || !testDistance || !previewTotal || !previewError) return;
    const slabs = Array.from(slabList.querySelectorAll("[data-distance-slab]")).map((slab) => ({
      startMiles: slab.querySelector('input[name$="[startMiles]"]').value.trim(),
      endMiles: slab.querySelector('input[name$="[endMiles]"]').value.trim(),
      ratePerMile: slab.querySelector('input[name$="[ratePerMile]"]').value.trim()
    }));
    try {
      window.calculateDistanceSlabFare(slabs, "0");
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      previewError.textContent = "This distance schedule is incomplete or invalid. Complete contiguous slabs and leave the final end blank to preview.";
      testDistance.removeAttribute("aria-invalid");
      previewTotal.textContent = "—";
      return;
    }

    const distance = testDistance.value.trim();
    if (!distance) {
      previewError.textContent = "";
      testDistance.removeAttribute("aria-invalid");
      previewTotal.textContent = "—";
      return;
    }
    if (distance.length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(distance)) {
      previewError.textContent = "Enter a valid non-negative distance in miles.";
      testDistance.setAttribute("aria-invalid", "true");
      previewTotal.textContent = "—";
      return;
    }

    try {
      previewTotal.textContent = `£${window.calculateDistanceSlabFare(slabs, distance)}`;
      previewError.textContent = "";
      testDistance.removeAttribute("aria-invalid");
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      previewError.textContent = "Complete a valid contiguous schedule, including one open-ended final slab, to preview.";
      testDistance.removeAttribute("aria-invalid");
      previewTotal.textContent = "—";
    }
  };

  const updateSlabInputErrors = (event) => {
    const input = event.target.closest("[data-distance-slab] input");
    if (!input) return;
    input.removeAttribute("aria-invalid");
    const error = input.closest(".fare-settings__field").querySelector(".fare-settings__field-error");
    if (error) {
      error.textContent = "";
      error.classList.remove("fare-settings__field-error--invalid");
    }
  };

  dailyRadios.forEach((radio) => radio.addEventListener("change", updateDailyFields));
  bankHolidayRadios.forEach((radio) => radio.addEventListener("change", updatePeriodFields));
  addPeriodButton?.addEventListener("click", () => {
    if (!periodList || !periodTemplate) return;
    const index = periodList.querySelectorAll("[data-period]").length;
    const fragment = periodTemplate.content.cloneNode(true);
    const period = fragment.querySelector("[data-period]");
    period.innerHTML = period.innerHTML.replaceAll("ROW", String(index));
    periodList.append(fragment);
    reindexPeriods();
    periodList.querySelector(`[data-index="${index}"] input`)?.focus();
  });
  periodList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-period]");
    if (!button) return;
    button.closest("[data-period]").remove();
    reindexPeriods();
    addPeriodButton?.focus();
  });

  addSlabButton?.addEventListener("click", () => {
    if (!slabList || !slabTemplate) return;
    const existingSlabs = Array.from(slabList.querySelectorAll("[data-distance-slab]"));
    let nextStart = "0";
    if (existingSlabs.length) {
      const finalSlab = existingSlabs[existingSlabs.length - 1];
      const startInput = finalSlab.querySelector('input[name$="[startMiles]"]');
      const endInput = finalSlab.querySelector('input[name$="[endMiles]"]');
      const startDistance = parseSlabDistance(startInput.value);
      const endDistance = parseSlabDistance(endInput.value);
      if (!endInput.value.trim()) {
        addSlabError.textContent = "Enter an end distance for the current final slab before adding another slab.";
        addSlabError.hidden = false;
        endInput.focus();
        return;
      }
      if (!endDistance) {
        addSlabError.textContent = "Enter a valid non-negative end distance before adding another slab.";
        addSlabError.hidden = false;
        endInput.focus();
        return;
      }
      if (!startDistance) {
        addSlabError.textContent = "Enter a valid start distance for the current slab before adding another slab.";
        addSlabError.hidden = false;
        startInput.focus();
        return;
      }
      if (compareSlabDistances(endDistance, startDistance) <= 0) {
        addSlabError.textContent = "The end distance must be greater than the current slab's start distance before adding another slab.";
        addSlabError.hidden = false;
        endInput.focus();
        return;
      }
      nextStart = endDistance.text;
    }

    addSlabError.textContent = "";
    addSlabError.hidden = true;
    const fragment = slabTemplate.content.cloneNode(true);
    const index = existingSlabs.length;
    const slab = fragment.querySelector("[data-distance-slab]");
    slab.innerHTML = slab.innerHTML.replaceAll("ROW", String(index));
    slab.querySelector('input[name$="[startMiles]"]').value = nextStart;
    slabList.append(fragment);
    reindexSlabs();
    calculatePreview();
    slabList.querySelector(`[data-index="${index}"] input[name$="[ratePerMile]"]`)?.focus();
  });
  slabList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-distance-slab]");
    if (!button) return;
    button.closest("[data-distance-slab]").remove();
    reindexSlabs();
    calculatePreview();
    addSlabButton?.focus();
  });
  slabList?.addEventListener("input", (event) => {
    updateSlabInputErrors(event);
    if (event.target.matches('input[name$="[endMiles]"]') && addSlabError) {
      addSlabError.textContent = "";
      addSlabError.hidden = true;
    }
    reindexSlabs();
    calculatePreview();
  });
  testDistance?.addEventListener("input", calculatePreview);

  updateDailyFields();
  updatePeriodFields();
  reindexSlabs();
  calculatePreview();
})();
