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
      const title = slab.querySelector("[data-slab-title]");
      title.id = `distance-slab-${index}-title`;
      title.textContent = `Slab ${index + 1}${finalSlab ? " — open-ended final slab" : ""}`;
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
          error.textContent = "";
        }
        if (fieldName === "endMiles") {
          const note = field.querySelector("[data-open-ended-note]");
          if (note) {
            note.id = `${inputId}-help`;
            note.hidden = !finalSlab;
          }
          input.placeholder = finalSlab ? "Open-ended" : "";
          input.setAttribute("aria-label", `End distance in miles${finalSlab ? "; leave blank for open-ended final slab" : ""}`);
          input.setAttribute("aria-describedby", `${inputId}-help ${inputId}-error`);
        } else {
          input.setAttribute("aria-describedby", `${inputId}-error`);
        }
        input.removeAttribute("aria-invalid");
      });
      const removeButton = slab.querySelector("[data-remove-distance-slab]");
      removeButton.setAttribute("aria-label", `Remove slab ${index + 1}`);
    });
  };

  const calculatePreview = () => {
    if (!slabList || !testDistance || !previewTotal || !previewError) return;
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

    const slabs = Array.from(slabList.querySelectorAll("[data-distance-slab]")).map((slab) => ({
      startMiles: slab.querySelector('input[name$="[startMiles]"]').value.trim(),
      endMiles: slab.querySelector('input[name$="[endMiles]"]').value.trim(),
      ratePerMile: slab.querySelector('input[name$="[ratePerMile]"]').value.trim()
    }));
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
    if (error) error.textContent = "";
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
    const fragment = slabTemplate.content.cloneNode(true);
    const index = slabList.querySelectorAll("[data-distance-slab]").length;
    const slab = fragment.querySelector("[data-distance-slab]");
    slab.innerHTML = slab.innerHTML.replaceAll("ROW", String(index));
    slabList.append(fragment);
    reindexSlabs();
    calculatePreview();
    slabList.querySelector(`[data-index="${index}"] input`)?.focus();
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
    calculatePreview();
  });
  testDistance?.addEventListener("input", calculatePreview);

  updateDailyFields();
  updatePeriodFields();
  reindexSlabs();
  calculatePreview();
})();
