(function () {
  "use strict";

  const dialog = document.getElementById("staff-details-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;

  const frame = dialog.querySelector("iframe");
  const close = dialog.querySelector("[data-staff-details-close]");
  let trigger = null;

  function openDetails(action) {
    if (dialog.open) return;
    const url = new URL(action.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    url.searchParams.set("dialog", "1");
    trigger = action;
    frame.src = url.href;
    dialog.showModal();
    close.focus();
  }

  document.querySelectorAll("[data-staff-row]").forEach(function (row) {
    const action = row.querySelector("[data-staff-details]");
    if (!action) return;
    action.setAttribute("aria-haspopup", "dialog");
    action.setAttribute("aria-controls", dialog.id);

    row.addEventListener("dblclick", function (event) {
      if (event.target.closest("a, button, input, select, textarea, label, [contenteditable], [role='button']")) return;
      openDetails(action);
    });
    action.addEventListener("click", function (event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openDetails(action);
    });
    action.addEventListener("keydown", function (event) {
      if (event.key !== " " || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openDetails(action);
    });
  });

  function clearDetails() {
    frame.removeAttribute("src");
    if (trigger && trigger.isConnected) trigger.focus();
    trigger = null;
  }
  function dismiss() {
    dialog.close();
    clearDetails();
  }
  close.addEventListener("click", dismiss);
  dialog.addEventListener("cancel", function (event) {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("close", function () {
    if (!dialog.open) clearDetails();
  });
  frame.addEventListener("load", function () {
    if (!dialog.open) return;
    const detailDocument = frame.contentDocument;
    if (!detailDocument) return;
    detailDocument.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    });
  });
})();
