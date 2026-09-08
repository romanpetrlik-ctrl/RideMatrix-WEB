(function () {
  "use strict";

  window.RideMatrixMaps = {
    render: function (element, googleMaps) {
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
  };
}());
