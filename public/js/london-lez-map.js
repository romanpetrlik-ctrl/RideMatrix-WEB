(function () {
  "use strict";

  function setStatus(element, message) {
    var status = element.parentElement && element.parentElement.querySelector("[data-london-lez-map-status]");
    if (status) status.textContent = message;
  }

  function isPosition(value) {
    return Array.isArray(value)
      && value.length >= 2
      && Number.isFinite(value[0])
      && value[0] >= -180
      && value[0] <= 180
      && Number.isFinite(value[1])
      && value[1] >= -90
      && value[1] <= 90;
  }

  function mapRing(ring, bounds) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("Invalid polygon ring");
    return ring.map(function (position) {
      if (!isPosition(position)) throw new Error("Invalid boundary coordinates");
      var point = { lat: position[1], lng: position[0] };
      bounds.extend(point);
      return point;
    });
  }

  function polygonPaths(rings, bounds) {
    if (!Array.isArray(rings) || !rings.length) throw new Error("Invalid polygon");
    return rings.map(function (ring) { return mapRing(ring, bounds); });
  }

  function renderBoundary(element, maps, boundary) {
    if (!boundary || boundary.type !== "FeatureCollection" || !Array.isArray(boundary.features) || boundary.features.length !== 22) {
      throw new Error("The London LEZ boundary response is invalid");
    }

    var bounds = new maps.LatLngBounds();
    var pathsByPolygon = [];

    boundary.features.forEach(function (feature) {
      if (!feature || feature.type !== "Feature" || !feature.geometry) {
        throw new Error("The London LEZ boundary contains an invalid feature");
      }
      var polygons;
      if (feature.geometry.type === "Polygon") {
        polygons = [feature.geometry.coordinates];
      } else if (feature.geometry.type === "MultiPolygon") {
        polygons = feature.geometry.coordinates;
      } else {
        throw new Error("The London LEZ boundary contains an unsupported geometry");
      }
      polygons.forEach(function (rings) {
        pathsByPolygon.push(polygonPaths(rings, bounds));
      });
    });

    var map = new maps.Map(element, {
      center: { lat: 51.5, lng: -0.1 },
      zoom: 9,
      mapId: element.dataset.mapId || undefined,
      mapTypeControl: false,
      streetViewControl: false
    });
    pathsByPolygon.forEach(function (paths) {
      new maps.Polygon({
        paths: paths,
        map: map,
        strokeColor: "#075b67",
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: "#197d86",
        fillOpacity: 0.2
      });
    });

    map.fitBounds(bounds);
    setStatus(element, "London LEZ boundary displayed. 22 source features are shown. Powered by TfL Open Data.");
    return pathsByPolygon.length;
  }

  window.RideMatrixLondonLezMap = { renderBoundary: renderBoundary };

  if (typeof document === "undefined") return;
  document.addEventListener("DOMContentLoaded", function () {
    var elements = Array.prototype.slice.call(document.querySelectorAll("[data-london-lez-map]"));
    return Promise.all(elements.map(function (element) {
      var key = element.dataset.mapBrowserKey || "";
      if (!key) {
        setStatus(element, "Map preview unavailable because Google Maps is not configured.");
        return Promise.resolve();
      }

      var boundaryRequest;
      var mapsRequest;
      try {
        boundaryRequest = fetch(element.dataset.boundaryUrl, {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        }).then(function (response) {
          if (!response.ok) throw new Error("Boundary data request failed with status " + response.status);
          return response.json();
        });
        mapsRequest = window.RideMatrixMaps.load(key, [], {});
      } catch (_error) {
        setStatus(element, "Map preview unavailable. The boundary could not be fully loaded or rendered.");
        return Promise.resolve();
      }

      return Promise.all([boundaryRequest, mapsRequest]).then(function (results) {
        if (!results[1] || !window.google || !window.google.maps) {
          throw new Error("Google Maps is unavailable");
        }
        renderBoundary(element, window.google.maps, results[0]);
      }).catch(function () {
        setStatus(element, "Map preview unavailable. The boundary could not be fully loaded or rendered.");
      });
    }));
  });
}());
