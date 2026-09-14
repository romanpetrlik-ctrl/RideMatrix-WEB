(function () {
  "use strict";

  var canUseWeakSet = typeof WeakSet === "function";
  var rendered = canUseWeakSet ? new WeakSet() : [];
  var loading;

  function ensureLibraries(libraries) {
    if (!Array.isArray(libraries) || libraries.length === 0) return Promise.resolve(true);
    if (!window.google || !window.google.maps) return Promise.resolve(false);
    if (typeof window.google.maps.importLibrary === "function") {
      return Promise.all(libraries.map(function (library) {
        return window.google.maps.importLibrary(library);
      })).then(function () { return true; });
    }
    return Promise.resolve(libraries.every(function (library) {
      return library !== "places" || Boolean(window.google.maps.places);
    }));
  }

  function render(element, googleMaps) {
      if (!element || (canUseWeakSet ? rendered.has(element) : rendered.indexOf(element) !== -1)) return true;
      var position = {
        lat: Number(element.dataset.mapLatitude),
        lng: Number(element.dataset.mapLongitude)
      };
      var canvas = element.querySelector(".address-map-preview__canvas");
      if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng) || !googleMaps || !canvas) return false;
      new googleMaps.Map(canvas, {
        center: position,
        zoom: Number(element.dataset.mapZoom) || 14,
        mapId: element.dataset.mapId || undefined,
        disableDefaultUI: true
      });
      if (canUseWeakSet) rendered.add(element);
      else rendered.push(element);
      return true;
  }

  window.RideMatrixMaps = {
    render: render,
    load: function (browserKey, elements, options) {
      var previewElements = Array.isArray(elements) ? elements : [];
      var libraries = options && Array.isArray(options.libraries) ? options.libraries.filter(Boolean) : [];
      if (!browserKey) return Promise.resolve(false);
      if (window.google && window.google.maps) {
        return ensureLibraries(libraries).then(function () {
          previewElements.forEach(function (element) { render(element, window.google.maps); });
          return true;
        });
      }
      if (loading) {
        return loading.then(function () {
          return ensureLibraries(libraries).then(function () {
            previewElements.forEach(function (element) { render(element, window.google.maps); });
            return true;
          });
        });
      }

      loading = new Promise(function (resolve, reject) {
        var callback = "rideMatrixMapsLoaded";
        window[callback] = function () {
          loading = null;
          resolve(true);
          delete window[callback];
        };
        var script = document.createElement("script");
        script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(browserKey) + "&callback=" + callback + "&loading=async";
        script.async = true;
        script.onerror = function () { loading = null; reject(new Error("Google Maps preview unavailable")); };
        document.head.appendChild(script);
      });
      return loading.then(function () {
        return ensureLibraries(libraries).then(function () {
          previewElements.forEach(function (element) { render(element, window.google.maps); });
          return true;
        });
      });
    }
  };

  if (typeof document === "undefined") return;
  function showUnavailable(elements) {
  elements.forEach(function (element) {
    var message = element.querySelector("[data-map-error]");
    if (message) message.hidden = false;
  });
  }

  if (typeof document === "undefined") return;
  document.addEventListener("DOMContentLoaded", function () {
    var elements = Array.prototype.slice.call(document.querySelectorAll(".address-map-preview[data-map-browser-key]"));
    var autocompleteRoots = Array.prototype.slice.call(document.querySelectorAll("[data-address-autocomplete-browser-key]"));
    var browserKey = autocompleteRoots.length
      ? autocompleteRoots[0].dataset.addressAutocompleteBrowserKey
      : (elements.length ? elements[0].dataset.mapBrowserKey : "");
    if (browserKey && (elements.length || autocompleteRoots.length)) {
      window.RideMatrixMaps.load(browserKey, elements, {
        libraries: autocompleteRoots.length ? ["places"] : []
      }).catch(function () { showUnavailable(elements); });
    } else if (elements.length) {
      showUnavailable(elements);
    }
  });
}());
