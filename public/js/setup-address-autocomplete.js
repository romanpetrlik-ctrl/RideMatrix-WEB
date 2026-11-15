(function () {
  "use strict";

  var PLACE_FIELDS = ["id", "formattedAddress", "addressComponents", "location", "displayName"];

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function componentValue(components, type, property) {
    var match = components.find(function (component) {
      return Array.isArray(component.types) && component.types.indexOf(type) !== -1;
    });
    if (!match) return "";
    var value = match[property];
    if (value && typeof value === "object" && typeof value.text === "string") return text(value.text);
    return text(value);
  }

  function readLocation(place) {
    var location = place && place.location;
    if (!location) return null;
    var latitude = typeof location.lat === "function" ? location.lat() : location.lat;
    var longitude = typeof location.lng === "function" ? location.lng() : location.lng;
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? { latitude: String(latitude), longitude: String(longitude) }
      : null;
  }

  function bind(form) {
    if (!form) return;
    var browserKey = form.dataset.addressAutocompleteBrowserKey || "";
    var search = form.querySelector("#operationalPlaceSearch");
    var host = form.querySelector("[data-place-autocomplete-host]");
    var status = form.querySelector("#operationalPlaceStatus");
    var placeFields = {
      houseNameNumber: form.querySelector("#houseNameNumber"),
      addressLine1: form.querySelector("#addressLine1"),
      addressLine2: form.querySelector("#addressLine2"),
      addressLine3: form.querySelector("#addressLine3"),
      cityTown: form.querySelector("#cityTown"),
      county: form.querySelector("#county"),
      state: form.querySelector("#state"),
      postcode: form.querySelector("#postcode"),
      countryCode: form.querySelector("#countryCode"),
      countryName: form.querySelector("#countryName"),
      latitude: form.querySelector("#latitude"),
      longitude: form.querySelector("#longitude"),
      providerName: form.querySelector("#providerName"),
      providerPlaceId: form.querySelector("#providerPlaceId")
    };

    function setStatus(message) {
      if (status) status.textContent = message;
    }

    function clearSelection() {
      ["latitude", "longitude", "providerPlaceId"].forEach(function (name) {
        if (placeFields[name]) placeFields[name].value = "";
      });
      if (placeFields.providerName) placeFields.providerName.value = "";
    }

    if (search) {
      search.addEventListener("input", clearSelection);
    }
    [
      "houseNameNumber", "addressLine1", "addressLine2", "addressLine3", "cityTown",
      "county", "state", "postcode", "countryCode", "countryName"
    ].forEach(function (name) {
      if (placeFields[name]) placeFields[name].addEventListener("input", clearSelection);
    });
    if (!browserKey || !window.RideMatrixMaps || typeof window.RideMatrixMaps.load !== "function") {
      setStatus("Google Places is unavailable. You can enter the address manually; coordinates will not be verified and dead-mileage will remain unavailable.");
      return;
    }

    setStatus("Loading Google Places.");
    window.RideMatrixMaps.load(browserKey, [], { libraries: ["places"] })
      .then(function () {
        if (!window.google || !window.google.maps || typeof window.google.maps.importLibrary !== "function") {
          throw new Error("Google Places is unavailable.");
        }
        return window.google.maps.importLibrary("places");
      })
      .then(function (placesLibrary) {
        var PlaceAutocompleteElement = placesLibrary && placesLibrary.PlaceAutocompleteElement;
        if (typeof PlaceAutocompleteElement !== "function" || !host) {
          throw new Error("Google Places autocomplete is unavailable.");
        }

        var autocomplete = new PlaceAutocompleteElement();
        autocomplete.className = "setup-wizard__place-autocomplete";
        autocomplete.setAttribute("aria-label", "Search operating address");
        autocomplete.includedRegionCodes = ["gb"];
        host.replaceChildren(autocomplete);
        host.hidden = false;
        if (search) search.hidden = true;
        setStatus("Select the correct address from the Google Places suggestions.");

        autocomplete.addEventListener("gmp-select", function (event) {
          var prediction = event && (event.placePrediction || (event.detail && event.detail.placePrediction));
          if (!prediction || typeof prediction.toPlace !== "function") {
            clearSelection();
            setStatus("Select a Google Places result to set the verified address and coordinates.");
            return;
          }
          var place = prediction.toPlace();
          if (!place || typeof place.fetchFields !== "function") {
            clearSelection();
            setStatus("The selected Google Place could not be verified. Select another result.");
            return;
          }

          Promise.resolve(place.fetchFields({ fields: PLACE_FIELDS })).then(function () {
            var components = Array.isArray(place.addressComponents) ? place.addressComponents : [];
            var location = readLocation(place);
            var placeId = text(place.id || prediction.id || prediction.placeId);
            var countryCode = componentValue(components, "country", "shortText");
            var countryName = componentValue(components, "country", "longText");
            var route = componentValue(components, "route", "longText");
            var premise = componentValue(components, "premise", "longText");
            var streetNumber = componentValue(components, "street_number", "longText");
            var values = {
              houseNameNumber: [componentValue(components, "subpremise", "longText"), premise, streetNumber]
                .filter(function (value, index, list) { return value && list.indexOf(value) === index; })
                .join(", "),
              addressLine1: route || premise || text(place.displayName && place.displayName.text),
              addressLine2: componentValue(components, "sublocality_level_1", "longText")
                || componentValue(components, "sublocality", "longText"),
              addressLine3: componentValue(components, "administrative_area_level_2", "longText"),
              cityTown: componentValue(components, "postal_town", "longText")
                || componentValue(components, "locality", "longText")
                || componentValue(components, "administrative_area_level_2", "longText"),
              county: componentValue(components, "administrative_area_level_2", "longText"),
              state: componentValue(components, "administrative_area_level_1", "longText"),
              postcode: [componentValue(components, "postal_code", "longText"),
                componentValue(components, "postal_code_suffix", "longText")].filter(Boolean).join(" "),
              countryCode: countryCode,
              countryName: countryName
            };
            if (!placeId || !location || !values.addressLine1
              || !values.cityTown || !values.postcode || !values.countryCode || !values.countryName) {
              clearSelection();
              setStatus("The selected Google Place is missing required address details. Select another result.");
              return;
            }

            Object.keys(values).forEach(function (name) {
              if (placeFields[name]) placeFields[name].value = values[name];
            });
            placeFields.latitude.value = location.latitude;
            placeFields.longitude.value = location.longitude;
            placeFields.providerName.value = "google";
            placeFields.providerPlaceId.value = placeId;
            if (search) search.value = text(place.formattedAddress);
            setStatus("Google Place selected. The server will verify the UK address and coordinates when you save.");
          }).catch(function () {
            clearSelection();
            setStatus("Google Places could not verify this selection. Select another result.");
          });
        });
      })
      .catch(function () {
        setStatus("Google Places is unavailable. You can enter the address manually; coordinates will not be verified and dead-mileage will remain unavailable.");
      });
  }

  window.RideMatrixSetupAddressAutocomplete = { bind: bind };

  if (typeof document === "undefined") return;
  document.addEventListener("DOMContentLoaded", function () {
    Array.prototype.slice.call(document.querySelectorAll("[data-setup-address-form]")).forEach(bind);
  });
}());
