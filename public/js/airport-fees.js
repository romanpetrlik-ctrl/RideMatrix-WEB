(function () {
  "use strict";

  var PLACE_FIELDS = ["id", "displayName", "formattedAddress", "location"];

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function readLocation(place) {
    var location = place && place.location;
    if (!location) return null;
    var latitude = typeof location.lat === "function" ? location.lat() : location.lat;
    var longitude = typeof location.lng === "function" ? location.lng() : location.lng;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude: String(latitude), longitude: String(longitude) };
  }

  function bindPlaceRoot(root) {
    var key = root.dataset.airportPlaceBrowserKey;
    var host = root.querySelector("[data-airport-place-autocomplete-host]");
    var input = root.querySelector('input[name$="LocationLabel"]');
    var placeId = root.querySelector('input[name$="PlaceId"]');
    var latitude = root.querySelector('input[name$="Latitude"]');
    var longitude = root.querySelector('input[name$="Longitude"]');
    var status = root.querySelector("[data-airport-place-status]");
    if (!key || !host || !input || !placeId || !latitude || !longitude || !status) return;

    function clearSelection() {
      placeId.value = "";
      latitude.value = "";
      longitude.value = "";
      input.value = "";
    }

    function unavailable() {
      status.textContent = "Google Places is unavailable. This location cannot be saved until suggestions load.";
    }

    if (!window.RideMatrixMaps || typeof window.RideMatrixMaps.load !== "function") {
      unavailable();
      return;
    }

    window.RideMatrixMaps.load(key, [], { libraries: ["places"] }).then(function () {
      if (!window.google || !window.google.maps || typeof window.google.maps.importLibrary !== "function") {
        throw new Error("Google Places library unavailable");
      }
      return window.google.maps.importLibrary("places");
    }).then(function (places) {
      var PlaceAutocompleteElement = places && places.PlaceAutocompleteElement;
      if (typeof PlaceAutocompleteElement !== "function") {
        throw new Error("Google Places autocomplete unavailable");
      }

      var autocomplete = new PlaceAutocompleteElement();
      autocomplete.setAttribute("aria-label", "Search Google Places for an operational airport location");
      host.appendChild(autocomplete);
      status.textContent = "Search and select a Google Places result to save its operational point.";

      autocomplete.addEventListener("gmp-select", function (event) {
        var prediction = event && (event.placePrediction || (event.detail && event.detail.placePrediction));
        if (!prediction || typeof prediction.toPlace !== "function") {
          clearSelection();
          status.textContent = "Select a Google Places suggestion to set this location.";
          return;
        }

        var place = prediction.toPlace();
        if (!place || typeof place.fetchFields !== "function") {
          clearSelection();
          status.textContent = "The selected Google Place could not be loaded. Choose another result.";
          return;
        }

        Promise.resolve(place.fetchFields({ fields: PLACE_FIELDS })).then(function () {
          var point = readLocation(place);
          var id = text(place.id || place.placeId);
          var displayName = place.displayName && typeof place.displayName.text === "string"
            ? text(place.displayName.text)
            : "";
          var label = displayName || text(place.formattedAddress);
          if (!id || !label || !point) {
            clearSelection();
            status.textContent = "The selected result has no usable Place ID or coordinates. Choose another result.";
            return;
          }

          placeId.value = id;
          latitude.value = point.latitude;
          longitude.value = point.longitude;
          input.value = label;
          input.setAttribute("aria-invalid", "false");
          status.textContent = "Google Place selected. Its Place ID and operational coordinates will be saved.";
        }).catch(unavailable);
      });
    }).catch(unavailable);
  }

  if (typeof document === "undefined") return;
  document.addEventListener("DOMContentLoaded", function () {
    Array.prototype.slice.call(document.querySelectorAll("[data-airport-place-root]")).forEach(bindPlaceRoot);

    document.addEventListener("click", function (event) {
      var openButton = event.target.closest("[data-airport-delete-open]");
      if (openButton) {
        var dialog = document.getElementById(openButton.dataset.airportDeleteOpen);
        if (dialog && typeof dialog.showModal === "function") dialog.showModal();
        return;
      }
      var cancelButton = event.target.closest("[data-airport-delete-cancel]");
      if (cancelButton) cancelButton.closest("dialog").close();
    });

    var form = document.querySelector(".airport-fees__form");
    if (form) {
      form.addEventListener("submit", function (event) {
        var validPlaces = Array.prototype.slice.call(form.querySelectorAll("[data-airport-place-root]")).every(function (root) {
          return Boolean(
            root.querySelector('input[name$="PlaceId"]').value
            && root.querySelector('input[name$="Latitude"]').value
            && root.querySelector('input[name$="Longitude"]').value
          );
        });
        if (!validPlaces) {
          event.preventDefault();
          var missingRoot = Array.prototype.slice.call(form.querySelectorAll("[data-airport-place-root]")).find(function (root) {
            return !root.querySelector('input[name$="PlaceId"]').value;
          });
          var missing = missingRoot && missingRoot.querySelector('input[name$="LocationLabel"]');
          if (missing) missing.focus();
          form.querySelectorAll("[data-airport-place-root]").forEach(function (root) {
            if (!root.querySelector('input[name$="PlaceId"]').value) {
              root.querySelector("[data-airport-place-status]").textContent = "Select a Google Places suggestion before saving.";
              root.querySelector('input[name$="LocationLabel"]').setAttribute("aria-invalid", "true");
            }
          });
        }
      });
    }
  });
}());
