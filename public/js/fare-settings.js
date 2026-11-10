(() => {
  const dailyDetails = document.querySelector("[data-fare-settings-details]");
  const dailyRadios = document.querySelectorAll('input[name="dailyEnabled"]');
  const bankHolidayRadios = document.querySelectorAll('input[name="bankHolidayEnabled"]');
  const periodList = document.querySelector("[data-period-list]");
  const periodTemplate = document.querySelector("#fare-settings-period-template");
  const addPeriodButton = document.querySelector("[data-add-period]");
  if (!dailyDetails && !periodList) return;

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

  updateDailyFields();
  updatePeriodFields();
})();
