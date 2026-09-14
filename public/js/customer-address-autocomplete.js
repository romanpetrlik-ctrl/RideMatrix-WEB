(function () {
  "use strict";

  function toText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function indexComponents(place) {
    var lookup = {};
    var components = place && Array.isArray(place.address_components) ? place.address_components : [];
    components.forEach(function (component) {
      if (!component || !Array.isArray(component.types)) return;
      component.types.forEach(function (type) {
        if (!lookup[type] && typeof component.long_name === "string" && component.long_name.trim()) {
          lookup[type] = component.long_name.trim();
        }
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
    var location = place && place.geometry && place.geometry.location;
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
    var addressLine1 = components.route || components.premise || toText(place && place.name) || "";
    var addressLine2 = components.sublocality_level_1 || components.sublocality || components.neighborhood || "";
    var county = components.administrative_area_level_2 || "";

    return {
      address: toText(place && place.formatted_address),
      addressSearch: toText(place && place.formatted_address),
      houseNameNumber: houseNameNumber,
      addressLine1: addressLine1,
      addressLine2: addressLine2,
      addressLine3: county && county !== cityTown ? county : "",
      cityTown: cityTown,
      county: county,
      state: components.administrative_area_level_1 || "",
      postcode: postcode,
      latitude: readLocation(place).latitude,
      longitude: readLocation(place).longitude
    };
  }

  function clearCoordinates(fields) {
    if (fields.latitude) fields.latitude.value = "";
    if (fields.longitude) fields.longitude.value = "";
  }

  function applyAddress(fields, nextValues) {
    Object.keys(nextValues).forEach(function (key) {
      if (fields[key]) fields[key].value = nextValues[key] || "";
    });
  }

  function bindAutocomplete(form) {
    if (!form) return;
    var browserKey = form.dataset.addressAutocompleteBrowserKey || "";
    var fields = {
      address: form.querySelector("#address"),
      addressSearch: form.querySelector("#addressSearch"),
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
    if (!fields.addressSearch) return;
    if (!browserKey || !window.RideMatrixMaps || typeof window.RideMatrixMaps.load !== "function") {
      setStatus("Google address suggestions are unavailable. Enter the address manually.");
      return;
    }

    var internalUpdate = false;
    function markManualAddressChange() {
      if (internalUpdate) return;
      if (fields.address) fields.address.value = toText(fields.addressSearch && fields.addressSearch.value);
      clearCoordinates(fields);
    }

    [
      fields.addressSearch,
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

    setStatus("Loading Google address suggestions. Manual entry still works.");
    window.RideMatrixMaps.load(browserKey, [], { libraries: ["places"] }).then(function () {
      if (!window.google || !window.google.maps || !window.google.maps.places || !window.google.maps.places.Autocomplete) {
        setStatus("Google address suggestions are unavailable. Enter the address manually.");
        return false;
      }

      var autocomplete = new window.google.maps.places.Autocomplete(fields.addressSearch, {
        types: ["address"],
        fields: ["address_components", "formatted_address", "geometry", "name"]
      });
      setStatus("Google address suggestions are available. You can still edit every field manually.");

      autocomplete.addListener("place_changed", function () {
        var nextValues = mapPlaceToAddress(autocomplete.getPlace());
        internalUpdate = true;
        applyAddress(fields, nextValues);
        internalUpdate = false;
      });

      return true;
    }).catch(function () {
      setStatus("Google address suggestions are unavailable. Enter the address manually.");
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
