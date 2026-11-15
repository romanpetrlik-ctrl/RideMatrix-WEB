(function () {
  "use strict";

  if (typeof document === "undefined") return;
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var openButton = target.closest("[data-poi-delete-open]");
    if (openButton) {
      var dialog = document.getElementById(openButton.dataset.poiDeleteOpen);
      if (dialog && typeof dialog.showModal === "function") dialog.showModal();
      return;
    }

    var cancelButton = target.closest("[data-poi-delete-cancel]");
    if (cancelButton) {
      var dialogToClose = cancelButton.closest("dialog");
      if (dialogToClose) dialogToClose.close();
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.querySelector(".poi-management__form");
    if (!form || !form.querySelector("[data-poi-place-root]")) return;
    form.addEventListener("submit", function (event) {
      var root = form.querySelector("[data-poi-place-root]");
      var placeId = root.querySelector('input[name="placeId"]');
      var latitude = root.querySelector('input[name="latitude"]');
      var longitude = root.querySelector('input[name="longitude"]');
      if (placeId.value && latitude.value && longitude.value) return;

      event.preventDefault();
      var label = root.querySelector('input[name="locationLabel"]');
      var status = root.querySelector("[data-poi-place-status]");
      label.setAttribute("aria-invalid", "true");
      status.textContent = "Select a Google Places suggestion before saving.";
      label.focus();
    });
  });
}());
