(function () {
  "use strict";

  var canUseWeakSet = typeof WeakSet === "function";
  var rendered = canUseWeakSet ? new WeakSet() : [];
  var loadingByKey = {};

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

  function normalizeLibraries(libraries) {
    return Array.isArray(libraries)
      ? libraries.filter(Boolean).map(function (library) { return String(library).trim(); }).filter(Boolean)
      : [];
  }

  window.RideMatrixMaps = {
    render: render,
    load: function (browserKey, elements, options) {
      var previewElements = Array.isArray(elements) ? elements : [];
      var libraries = normalizeLibraries(options && options.libraries);
      var librariesKey = libraries.slice().sort().join(",");
      if (!browserKey) return Promise.resolve(false);
      if (window.google && window.google.maps) {
        return ensureLibraries(libraries).then(function (loaded) {
          if (!loaded) throw new Error("Google Maps libraries unavailable");
          previewElements.forEach(function (element) { render(element, window.google.maps); });
          return true;
        });
      }
      var loaderKey = browserKey + "::" + librariesKey;
      if (loadingByKey[loaderKey]) {
        return loadingByKey[loaderKey].then(function () {
          return ensureLibraries(libraries).then(function (loaded) {
            if (!loaded) throw new Error("Google Maps libraries unavailable");
            previewElements.forEach(function (element) { render(element, window.google.maps); });
            return true;
          });
        });
      }

      loadingByKey[loaderKey] = new Promise(function (resolve, reject) {
        var callback = "rideMatrixMapsLoaded_" + Math.random().toString(36).slice(2);
        window[callback] = function () {
          delete loadingByKey[loaderKey];
          resolve(true);
          delete window[callback];
        };
        var script = document.createElement("script");
        script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(browserKey)
          + "&callback=" + callback
          + "&loading=async"
          + (libraries.length ? "&libraries=" + encodeURIComponent(libraries.join(",")) : "");
        script.async = true;
        script.onerror = function () {
          delete loadingByKey[loaderKey];
          reject(new Error("Google Maps preview unavailable"));
        };
        document.head.appendChild(script);
      });
      return loadingByKey[loaderKey].then(function () {
        return ensureLibraries(libraries).then(function (loaded) {
          if (!loaded) throw new Error("Google Maps libraries unavailable");
          previewElements.forEach(function (element) { render(element, window.google.maps); });
          return true;
        });
      });
    }
  };

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
