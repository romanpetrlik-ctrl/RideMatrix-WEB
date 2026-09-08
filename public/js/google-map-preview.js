(function () {
  "use strict";

  function render(element, googleMaps) {
      var position = {
        lat: Number(element.dataset.mapLatitude),
        lng: Number(element.dataset.mapLongitude)
      };
      if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng) || !googleMaps) return false;
      new googleMaps.Map(element.querySelector(".address-map-preview__canvas"), {
        center: position,
        zoom: Number(element.dataset.mapZoom) || 14,
        mapId: element.dataset.mapId || undefined,
        disableDefaultUI: true
      });
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

      return new Promise(function (resolve, reject) {
        var callback = "rideMatrixMapsLoaded";
        window[callback] = function () {
          elements.forEach(function (element) { render(element, window.google.maps); });
          resolve(true);
          delete window[callback];
        };
        var script = document.createElement("script");
        script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(browserKey) + "&callback=" + callback;
        script.async = true;
        script.onerror = function () { reject(new Error("Google Maps preview unavailable")); };
        document.head.appendChild(script);
      });
    }
  };
}());
