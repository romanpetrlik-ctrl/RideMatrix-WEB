(function () {
  "use strict";

  var rendered = typeof WeakSet === "function" ? new WeakSet() : [];
  var loading;

  function render(element, googleMaps) {
      if (!element || (rendered instanceof WeakSet ? rendered.has(element) : rendered.indexOf(element) !== -1)) return true;
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
      if (rendered instanceof WeakSet) rendered.add(element);
      else rendered.push(element);
      return true;
  }

  window.RideMatrixMaps = {
    render: render,
    load: function (browserKey, elements) {
      if (!browserKey || !Array.isArray(elements) || elements.length === 0) return Promise.resolve(false);
      if (window.google && window.google.maps) {
        elements.forEach(function (element) { render(element, window.google.maps); });
        return Promise.resolve(true);
      }
      if (loading) {
        return loading.then(function () {
          elements.forEach(function (element) { render(element, window.google.maps); });
          return true;
        });
      }

      loading = new Promise(function (resolve, reject) {
        var callback = "rideMatrixMapsLoaded";
        window[callback] = function () {
          elements.forEach(function (element) { render(element, window.google.maps); });
          loading = null;
          resolve(true);
          delete window[callback];
        };
        var script = document.createElement("script");
        script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(browserKey) + "&callback=" + callback;
        script.async = true;
        script.onerror = function () { loading = null; reject(new Error("Google Maps preview unavailable")); };
        document.head.appendChild(script);
      });
      return loading.then(function () {
        elements.forEach(function (element) { render(element, window.google.maps); });
        return true;
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
    var browserKey = elements.length ? elements[0].dataset.mapBrowserKey : "";
    if (browserKey && elements.length) {
      window.RideMatrixMaps.load(browserKey, elements).catch(function () { showUnavailable(elements); });
    } else if (elements.length) {
      showUnavailable(elements);
    }
  });
}());
