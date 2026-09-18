(function () {
  "use strict";

  var PLACE_FIELDS = ["formattedAddress", "addressComponents", "location", "displayName"];
  var AVAILABLE_STATUS = "Google address suggestions are available.";

  function toText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function readComponentName(component) {
    if (!component || typeof component !== "object") return "";
    if (typeof component.long_name === "string" && component.long_name.trim()) return component.long_name.trim();
    if (typeof component.longText === "string" && component.longText.trim()) return component.longText.trim();
    return "";
  }

  function readComponentTypes(component) {
    if (!component || typeof component !== "object") return [];
    if (Array.isArray(component.types)) return component.types;
    if (Array.isArray(component.type)) return component.type;
    return [];
  }

  function readFormattedAddress(place) {
    return toText(place && (place.formatted_address || place.formattedAddress));
  }

  function readDisplayName(place) {
    if (!place) return "";
    if (place.displayName && typeof place.displayName.text === "string") return toText(place.displayName.text);
    if (typeof place.displayName === "string") return toText(place.displayName);
    if (typeof place.name === "string") return toText(place.name);
    return "";
  }

  function readPredictionText(prediction) {
    if (!prediction || typeof prediction !== "object") return "";
    if (prediction.text && typeof prediction.text.text === "string") return toText(prediction.text.text);
    if (typeof prediction.text === "string") return toText(prediction.text);
    if (prediction.mainText && typeof prediction.mainText.text === "string") return toText(prediction.mainText.text);
    if (typeof prediction.mainText === "string") return toText(prediction.mainText);
    return "";
  }

  function indexComponents(place) {
    var lookup = {};
    var components = place && Array.isArray(place.address_components)
      ? place.address_components
      : (place && Array.isArray(place.addressComponents) ? place.addressComponents : []);
    components.forEach(function (component) {
      var name = readComponentName(component);
      var types = readComponentTypes(component);
      if (!name || !types.length) return;
      types.forEach(function (type) {
        if (!lookup[type]) lookup[type] = name;
      });
    });
    return lookup;
  }

  function unique(values) {
    return values.filter(function (value, index) {
      return value && values.indexOf(value) === index;
    });
  }

  function readLocation(place) {
    var location = (place && place.geometry && place.geometry.location) || (place && place.location);
    if (!location) return { latitude: "", longitude: "" };
    var latitude = typeof location.lat === "function" ? location.lat() : location.lat;
    var longitude = typeof location.lng === "function" ? location.lng() : location.lng;
    return {
      latitude: Number.isFinite(latitude) ? String(latitude) : "",
      longitude: Number.isFinite(longitude) ? String(longitude) : ""
    };
  }

  function mapPlaceToAddress(place) {
    var components = indexComponents(place);
    var cityTown = components.postal_town || components.locality || components.administrative_area_level_2 || "";
    var postcode = [components.postal_code, components.postal_code_suffix].filter(Boolean).join(" ");
    var houseNameNumber = unique([
      components.subpremise,
      components.premise,
      components.street_number
    ]).join(", ");
    var addressLine1 = components.route || components.premise || readDisplayName(place) || "";
    var addressLine2 = components.sublocality_level_1 || components.sublocality || components.neighborhood || "";
    var county = components.administrative_area_level_2 || "";
    var formattedAddress = readFormattedAddress(place);
    var location = readLocation(place);

    return {
      address: formattedAddress,
      addressSearch: formattedAddress,
      houseNameNumber: houseNameNumber,
      addressLine1: addressLine1,
      addressLine2: addressLine2,
      addressLine3: county && county !== cityTown ? county : "",
      cityTown: cityTown,
      county: county,
      state: components.administrative_area_level_1 || "",
      postcode: postcode,
      latitude: location.latitude,
      longitude: location.longitude
    };
  }

  function clearCoordinates(fields) {
    if (fields.latitude) fields.latitude.value = "";
    if (fields.longitude) fields.longitude.value = "";
  }

  function applyAddress(fields, nextValues) {
    Object.keys(nextValues).forEach(function (key) {
      if (key === "addressSearch") {
        if (fields.addressSearch) fields.addressSearch.value = nextValues[key] || "";
        if (fields.addressSearchManual) fields.addressSearchManual.value = nextValues[key] || "";
        return;
      }
      if (fields[key]) fields[key].value = nextValues[key] || "";
    });
  }

  function supportsPlaceAutocomplete() {
    return Boolean(window.google
      && window.google.maps
      && typeof window.google.maps.importLibrary === "function");
  }

  function hasStructuredAddress(nextValues) {
    return Boolean(nextValues
      && (nextValues.houseNameNumber
        || nextValues.addressLine1
        || nextValues.addressLine2
        || nextValues.addressLine3
        || nextValues.cityTown
        || nextValues.county
        || nextValues.state
        || nextValues.postcode));
  }

  function bindAutocomplete(form) {
    if (!form) return;
    var browserKey = form.dataset.addressAutocompleteBrowserKey || "";
    var fields = {
      address: form.querySelector("#address"),
      addressSearch: form.querySelector("#addressSearch"),
      addressSearchManual: form.querySelector("#addressSearchManual"),
      autocompleteHost: form.querySelector("[data-address-autocomplete-host]"),
      houseNameNumber: form.querySelector("#houseNameNumber"),
      addressLine1: form.querySelector("#addressLine1"),
      addressLine2: form.querySelector("#addressLine2"),
      addressLine3: form.querySelector("#addressLine3"),
      cityTown: form.querySelector("#cityTown"),
      county: form.querySelector("#county"),
      state: form.querySelector("#state"),
      postcode: form.querySelector("#postcode"),
      latitude: form.querySelector("#latitude"),
      longitude: form.querySelector("#longitude")
    };
    var status = form.querySelector("[data-address-autocomplete-status]");
    function setStatus(message) {
      if (status) status.textContent = message;
    }
    if (!fields.addressSearch && !fields.addressSearchManual) return;

    function getSearchValue() {
      if (fields.addressSearchManual) return toText(fields.addressSearchManual.value);
      if (fields.addressSearch) return toText(fields.addressSearch.value);
      return "";
    }

    function syncSearchValue(value) {
      if (fields.addressSearch) fields.addressSearch.value = value;
      if (fields.addressSearchManual) fields.addressSearchManual.value = value;
    }

    function setManualVisible(visible) {
      if (fields.addressSearchManual) fields.addressSearchManual.hidden = !visible;
      if (fields.autocompleteHost) fields.autocompleteHost.hidden = visible;
    }

    var internalUpdate = false;
    function markManualAddressChange() {
      if (internalUpdate) return;
      if (fields.address) fields.address.value = getSearchValue();
      syncSearchValue(getSearchValue());
      clearCoordinates(fields);
    }

    [
      fields.addressSearchManual || fields.addressSearch,
      fields.houseNameNumber,
      fields.addressLine1,
      fields.addressLine2,
      fields.addressLine3,
      fields.cityTown,
      fields.county,
      fields.state,
      fields.postcode
    ].filter(Boolean).forEach(function (field) {
      field.addEventListener("input", markManualAddressChange);
    });

    setManualVisible(true);
    if (!browserKey || !window.RideMatrixMaps || typeof window.RideMatrixMaps.load !== "function") {
      setStatus("Google address suggestions are unavailable. Continue with manual address entry.");
      return;
    }

    setStatus("Loading Google address suggestions. Manual entry still works.");
    window.RideMatrixMaps.load(browserKey, [], { libraries: ["places"] }).then(function () {
      if (!supportsPlaceAutocomplete()) throw new Error("Google Maps libraries unavailable");
      return window.google.maps.importLibrary("places");
    }).then(function (placesLibrary) {
      if (!fields.autocompleteHost) throw new Error("Autocomplete host missing");
      var PlaceAutocompleteElement = placesLibrary && placesLibrary.PlaceAutocompleteElement
        ? placesLibrary.PlaceAutocompleteElement
        : (window.google && window.google.maps && window.google.maps.places && window.google.maps.places.PlaceAutocompleteElement);
      if (typeof PlaceAutocompleteElement !== "function") throw new Error("Place autocomplete unavailable");

      while (fields.autocompleteHost.firstChild) {
        fields.autocompleteHost.removeChild(fields.autocompleteHost.firstChild);
      }

      var autocompleteElement = new PlaceAutocompleteElement();
      autocompleteElement.className = "private-customer-form__autocomplete-element";
      if (typeof autocompleteElement.setAttribute === "function") {
        autocompleteElement.setAttribute("aria-label", "Search address");
        autocompleteElement.setAttribute("aria-describedby", "addressSearch-help");
      }
      fields.autocompleteHost.appendChild(autocompleteElement);
      setManualVisible(false);
      setStatus(AVAILABLE_STATUS);

      autocompleteElement.addEventListener("gmp-select", function (event) {
        var placePrediction = event && (event.placePrediction || (event.detail && event.detail.placePrediction));
        var predictionText = readPredictionText(placePrediction);
        if (!placePrediction || typeof placePrediction.toPlace !== "function") {
          if (predictionText) {
            syncSearchValue(predictionText);
            if (fields.address) fields.address.value = predictionText;
          }
          clearCoordinates(fields);
          setManualVisible(true);
          setStatus("Selected place does not include usable structured fields. Enter details manually.");
          return;
        }
        var place = placePrediction.toPlace();
        if (!place || typeof place.fetchFields !== "function") {
          if (predictionText) {
            syncSearchValue(predictionText);
            if (fields.address) fields.address.value = predictionText;
          }
          clearCoordinates(fields);
          setManualVisible(true);
          setStatus("Selected place does not include usable structured fields. Enter details manually.");
          return;
        }
        var selectedAddressText = readFormattedAddress(place) || predictionText;

        Promise.resolve(place.fetchFields({ fields: PLACE_FIELDS })).then(function () {
          var nextValues = mapPlaceToAddress(place);
          internalUpdate = true;
          applyAddress(fields, nextValues);
          internalUpdate = false;
          if (!hasStructuredAddress(nextValues)) {
            var fallbackAddress = nextValues.addressSearch || selectedAddressText;
            if (fallbackAddress) {
              syncSearchValue(fallbackAddress);
              if (fields.address) fields.address.value = fallbackAddress;
            }
            clearCoordinates(fields);
            setManualVisible(true);
            setStatus("Selected place does not include usable structured fields. Enter details manually.");
            return;
          }
          setManualVisible(false);
          setStatus(AVAILABLE_STATUS);
        }).catch(function () {
          if (selectedAddressText) syncSearchValue(selectedAddressText);
          if (fields.address && selectedAddressText) fields.address.value = selectedAddressText;
          setStatus("Google address suggestions are unavailable. Continue with manual address entry.");
          clearCoordinates(fields);
          setManualVisible(true);
        });
      });

      return true;
    }).catch(function () {
      setStatus("Google address suggestions are unavailable. Continue with manual address entry.");
      setManualVisible(true);
      clearCoordinates(fields);
    });
  }

  window.RideMatrixAddressAutocomplete = {
    bindAutocomplete: bindAutocomplete,
    clearCoordinates: clearCoordinates,
    mapPlaceToAddress: mapPlaceToAddress
  };

  if (typeof document === "undefined") return;
  document.addEventListener("DOMContentLoaded", function () {
    Array.prototype.slice.call(document.querySelectorAll("form[data-address-autocomplete-browser-key]")).forEach(bindAutocomplete);
  });
}());
