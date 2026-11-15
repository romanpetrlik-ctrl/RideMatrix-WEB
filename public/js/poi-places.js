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
    var key = root.dataset.poiPlaceBrowserKey;
    var host = root.querySelector("[data-poi-place-autocomplete-host]");
    var label = root.querySelector('input[name="locationLabel"]');
    var placeId = root.querySelector('input[name="placeId"]');
    var latitude = root.querySelector('input[name="latitude"]');
    var longitude = root.querySelector('input[name="longitude"]');
    var status = root.querySelector("[data-poi-place-status]");
    if (!key || !host || !label || !placeId || !latitude || !longitude || !status) return;

    function clearSelection() {
      placeId.value = "";
      latitude.value = "";
      longitude.value = "";
      label.value = "";
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
      autocomplete.setAttribute("aria-label", "Search Google Places for an operational POI location");
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
          var locationLabel = displayName || text(place.formattedAddress);
          if (!id || !locationLabel || !point) {
            clearSelection();
            status.textContent = "The selected result has no usable Place ID or coordinates. Choose another result.";
            return;
          }

          placeId.value = id;
          latitude.value = point.latitude;
          longitude.value = point.longitude;
          label.value = locationLabel;
          label.setAttribute("aria-invalid", "false");
          status.textContent = "Google Place selected. Its Place ID and operational coordinates will be saved separately from the POI name.";
        }).catch(function () {
          clearSelection();
          unavailable();
        });
      });
    }).catch(unavailable);
  }

  if (typeof document === "undefined") return;
  document.addEventListener("DOMContentLoaded", function () {
    Array.prototype.slice.call(document.querySelectorAll("[data-poi-place-root]")).forEach(bindPlaceRoot);
  });
}());
