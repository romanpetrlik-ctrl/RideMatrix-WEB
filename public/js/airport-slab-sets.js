(() => {
  const list = document.querySelector("[data-airport-slab-list]");
  const addButton = document.querySelector("[data-add-airport-slab]");
  if (!list || !addButton) return;

  const fields = ["startMiles", "endMiles", "ratePerMile"];

  const reindex = () => {
    Array.from(list.querySelectorAll("[data-airport-slab]")).forEach((row, index) => {
      row.querySelector("[data-airport-slab-title]").textContent = `Slab ${index + 1}`;
      fields.forEach((field, column) => {
        const input = row.querySelectorAll("input")[column];
        const error = row.querySelectorAll(".fare-settings__field-error")[column];
        const label = row.querySelectorAll("label")[column];
        const id = `airport-slab-${index}-${field}`;
        input.name = `distanceSlabs[${index}][${field}]`;
        input.id = id;
        input.setAttribute("aria-describedby", `${id}-error`);
        label.htmlFor = id;
        error.id = `${id}-error`;
      });
    });
  };

  addButton.hidden = false;
  addButton.addEventListener("click", () => {
    const rows = list.querySelectorAll("[data-airport-slab]");
    const clone = rows[rows.length - 1].cloneNode(true);
    clone.querySelectorAll("input").forEach((input) => { input.value = ""; input.setAttribute("aria-invalid", "false"); });
    clone.querySelectorAll(".fare-settings__field-error").forEach((error) => {
      error.textContent = "";
      error.classList.remove("fare-settings__field-error--invalid");
      error.removeAttribute("role");
    });
    list.appendChild(clone);
    reindex();
    clone.querySelector("input").focus();
  });

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-airport-slab]");
    if (!button) return;
    const rows = list.querySelectorAll("[data-airport-slab]");
    if (rows.length <= 1) return;
    button.closest("[data-airport-slab]").remove();
    reindex();
  });
})();
