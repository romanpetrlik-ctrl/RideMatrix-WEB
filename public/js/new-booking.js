((root, factory) => {
  const logic = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = logic;
  } else {
    root.RideMatrixNewBooking = logic;
    if (typeof document !== "undefined") logic.init(document);
  }
})(globalThis, () => {
  const STOP_ORDER = ["pickup", "via1", "via2", "dropoff"];
  const STOP_TITLES = { pickup: "Pickup", via: "Via", dropoff: "Drop-off" };
  const STATUS_LABELS = {
    applied: "Applied",
    zero: "Configured £0.00",
    "not-applicable": "Not applicable",
    unresolved: "Unresolved"
  };

  const plural = (count, singular, pluralForm) => `${count} ${count === 1 ? singular : pluralForm}`;

  /** Mirrors cargoSummary() in src/services/new-bookings.ts. */
  function cargoSummary(counts, childSeat, booster) {
    const value = (key) => Number(counts[key]) || 0;
    const passengers = value("adults") + value("children");
    const bags = value("xlBaggage") + value("lBaggage") + value("cabinHandBags") + value("backpacks");
    const parts = [
      `${plural(passengers, "passenger", "passengers")} (${plural(value("adults"), "adult", "adults")}, ${plural(value("children"), "child", "children")})`,
      `${plural(bags, "bag", "bags")} (XL ${value("xlBaggage")}, L ${value("lBaggage")}, CB/HB ${value("cabinHandBags")}, BP ${value("backpacks")})`,
      plural(value("sportsEquipment"), "sports item", "sports items")
    ];
    const seats = [childSeat ? "child seat" : "", booster ? "booster" : ""].filter(Boolean);
    parts.push(seats.length ? `Requires ${seats.join(" and ")}` : "No child seat or booster");
    return parts.join(" · ");
  }

  /** Passenger values while synchronized follow the manager; otherwise the passenger's own values are kept. */
  function passengerState(manager, passenger, passengerIsManager) {
    return passengerIsManager
      ? { name: manager.name, phone: manager.phone, readOnly: true }
      : { name: passenger.name, phone: passenger.phone, readOnly: false };
  }

  function formatDuration(seconds) {
    const minutes = Math.round(Number(seconds) / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  }

  function activeStopKeys(viaActive) {
    return STOP_ORDER.filter((key) => (key !== "via1" && key !== "via2") || Boolean(viaActive[key]));
  }

  function nextViaToAdd(viaActive) {
    if (!viaActive.via1) return "via1";
    if (!viaActive.via2) return "via2";
    return null;
  }

  /** Removing Via 1 while Via 2 is active moves Via 2 up so the route order is preserved without gaps. */
  function removeVia(viaActive, key) {
    if (key === "via1" && viaActive.via2) return { via1: true, via2: false, shiftVia2IntoVia1: true };
    return { via1: key === "via1" ? false : Boolean(viaActive.via1), via2: key === "via2" ? false : Boolean(viaActive.via2), shiftVia2IntoVia1: false };
  }

  function routeSummary(route) {
    if (!route || route.status !== "resolved") {
      return {
        distance: "Unresolved",
        duration: "Unresolved",
        charges: "Unresolved",
        message: route && route.message ? route.message : ""
      };
    }
    const warnings = [
      ...(route.tollsReported ? ["Tolls reported on route"] : []),
      ...(route.zones || []).map((zone) => `Enters ${zone.label}`),
      ...(route.tunnelCrossings || []).map((crossing) => `${crossing.label} (${crossing.direction})`)
    ];
    return {
      distance: `${Number(route.distanceMiles).toFixed(2)} miles`,
      duration: formatDuration(route.durationSeconds),
      charges: warnings.length ? warnings.join("; ") : "None detected",
      message: ""
    };
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);

  function formatAmount(amount) {
    if (amount === null || amount === undefined) return "—";
    const text = String(amount);
    return text.startsWith("-") ? `−£${text.slice(1)}` : `£${text}`;
  }

  /** Mirrors src/views/partials/booking-price-breakdown.ejs. */
  function priceBreakdownHtml(price) {
    if (!price) {
      return '<div class="booking-price" data-booking-price data-price-status="pending"><p class="booking-price__pending" data-booking-price-pending>Select pickup, drop-off and a service date/time to calculate the itemized price.</p></div>';
    }
    const rows = price.lines.map((line) => `<tr class="booking-price__line booking-price__line--${escapeHtml(line.status)}" data-price-line="${escapeHtml(line.type)}" data-price-line-status="${escapeHtml(line.status)}">`
      + `<th scope="row">${escapeHtml(line.label)}</th>`
      + `<td><span class="booking-price__status booking-price__status--${escapeHtml(line.status)}">${escapeHtml(STATUS_LABELS[line.status] || line.status)}</span></td>`
      + `<td class="booking-price__basis">${escapeHtml(line.basis)}</td>`
      + `<td class="booking-price__amount">${escapeHtml(formatAmount(line.amount))}</td></tr>`).join("");
    const unresolved = price.lines.filter((line) => line.status === "unresolved").length;
    const total = price.status === "complete" ? escapeHtml(formatAmount(price.total)) : "Not confirmed";
    return `<div class="booking-price" data-booking-price data-price-status="${escapeHtml(price.status)}">`
      + '<table class="booking-price__table"><caption class="visually-hidden">Itemized price breakdown</caption>'
      + '<thead><tr><th scope="col">Item</th><th scope="col">Status</th><th scope="col">Basis</th><th scope="col" class="booking-price__amount">Amount</th></tr></thead>'
      + `<tbody>${rows}</tbody>`
      + `<tfoot><tr class="booking-price__total" data-price-total><th scope="row" colspan="3">Total payable</th><td class="booking-price__amount"><strong>${total}</strong></td></tr></tfoot></table>`
      + (price.status === "complete" ? "" : `<p class="notice notice--critical booking-price__incomplete" role="status">Price incomplete: ${plural(unresolved, "item", "items")} unresolved. No total is payable or confirmed until every item is resolved.</p>`)
      + "</div>";
  }

  function stopListHtml(stops) {
    return stops.map((stop) => `<li><strong>${escapeHtml(STOP_TITLES[stop.type] || stop.type)}:</strong> ${escapeHtml(stop.label)}${stop.coordinatesVerified ? "" : " (unverified — no coordinates)"}</li>`).join("");
  }

  function init(doc) {
    const start = () => {
      const form = doc.querySelector("[data-new-booking-form]");
      if (form) wireForm(doc, form);
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
    else start();
  }

  function wireForm(doc, form) {
    const $ = (selector) => form.querySelector(selector);
    const $$ = (selector) => Array.prototype.slice.call(form.querySelectorAll(selector));
    const managerSelect = $("[data-manager-select]");
    const manager = { name: $("input[data-manager-name]"), phone: $("input[data-manager-phone]"), email: $("input[data-manager-email]") };
    const passenger = { name: $("[data-passenger-name]"), phone: $("[data-passenger-phone]") };
    const passengerIsManager = $("[data-passenger-is-manager]");
    const syncHint = $("[data-passenger-sync-hint]");
    // Independent passenger values are remembered so unchecking restores what the dispatcher typed.
    const ownPassenger = { name: passengerIsManager.checked ? "" : passenger.name.value, phone: passengerIsManager.checked ? "" : passenger.phone.value };

    const syncPassenger = () => {
      const state = passengerState(
        { name: manager.name.value, phone: manager.phone.value },
        ownPassenger,
        passengerIsManager.checked
      );
      passenger.name.value = state.name;
      passenger.phone.value = state.phone;
      passenger.name.readOnly = state.readOnly;
      passenger.phone.readOnly = state.readOnly;
      if (syncHint) syncHint.hidden = !state.readOnly;
    };
    passenger.name.addEventListener("input", () => { if (!passengerIsManager.checked) ownPassenger.name = passenger.name.value; });
    passenger.phone.addEventListener("input", () => { if (!passengerIsManager.checked) ownPassenger.phone = passenger.phone.value; });
    [manager.name, manager.phone].forEach((input) => input.addEventListener("input", syncPassenger));
    passengerIsManager.addEventListener("change", syncPassenger);
    managerSelect.addEventListener("change", () => {
      const option = managerSelect.selectedOptions[0];
      if (!option || !option.value) return;
      manager.name.value = option.dataset.managerName || "";
      manager.phone.value = option.dataset.managerPhone || "";
      manager.email.value = option.dataset.managerEmail || "";
      syncPassenger();
    });
    syncPassenger();

    const cargoTarget = doc.querySelector("[data-cargo-summary]");
    const updateCargo = () => {
      const counts = {};
      $$("[data-cargo-count]").forEach((select) => { counts[select.name] = Number(select.value) || 0; });
      cargoTarget.textContent = cargoSummary(counts, $("#childSeatRequired").value === "yes", $("#boosterRequired").value === "yes");
    };
    $$("[data-cargo-count], [data-cargo-flag]").forEach((select) => select.addEventListener("change", updateCargo));
    updateCargo();

    const stopElement = (key) => $(`[data-stop="${key}"]`);
    const showKindPanel = (fieldset) => {
      const kind = fieldset.querySelector("[data-stop-kind]").value;
      fieldset.querySelectorAll("[data-stop-panel]").forEach((panel) => { panel.hidden = panel.dataset.stopPanel !== kind; });
    };
    $$("[data-stop]").forEach((fieldset) => {
      fieldset.querySelector("[data-stop-kind]").addEventListener("change", () => showKindPanel(fieldset));
      showKindPanel(fieldset);
      const label = fieldset.querySelector("[data-address-label]");
      const placeId = fieldset.querySelector("[data-address-place-id]");
      label.addEventListener("input", () => {
        placeId.value = "";
        fieldset.querySelector("[data-address-status]").textContent = "Unverified address: select a Google Places suggestion to resolve the route.";
      });
    });

    const viaState = () => ({ via1: !stopElement("via1").hidden, via2: !stopElement("via2").hidden });
    const addViaButton = $("[data-add-via]");
    const setVia = (key, active) => {
      const fieldset = stopElement(key);
      fieldset.hidden = !active;
      fieldset.querySelector("[data-via-active]").value = active ? "yes" : "";
    };
    const copyStop = (from, to) => {
      ["Kind", "AirportId", "PoiId", "Label", "PlaceId"].forEach((suffix) => {
        form.elements[`${to}${suffix}`].value = form.elements[`${from}${suffix}`].value;
      });
      showKindPanel(stopElement(to));
    };
    const clearStop = (key) => {
      ["Kind", "AirportId", "PoiId", "Label", "PlaceId"].forEach((suffix) => { form.elements[`${key}${suffix}`].value = ""; });
      showKindPanel(stopElement(key));
    };
    const refreshViaButton = () => { addViaButton.hidden = nextViaToAdd(viaState()) === null; };
    addViaButton.addEventListener("click", () => {
      const key = nextViaToAdd(viaState());
      if (!key) return;
      setVia(key, true);
      refreshViaButton();
      scheduleQuote();
      stopElement(key).querySelector("[data-stop-kind]").focus();
    });
    $$("[data-remove-via]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.removeVia;
      const next = removeVia(viaState(), key);
      if (next.shiftVia2IntoVia1) {
        copyStop("via2", "via1");
        clearStop("via2");
      } else {
        clearStop(key);
      }
      setVia("via1", next.via1);
      setVia("via2", next.via2);
      refreshViaButton();
      updatePoiFeeOptions();
      scheduleQuote();
    }));
    refreshViaButton();

    const updatePoiFeeOptions = () => {
      const selected = activeStopKeys(viaState())
        .filter((key) => form.elements[`${key}Kind`].value === "poi")
        .map((key) => form.elements[`${key}PoiId`].value)
        .filter(Boolean);
      $$("[data-poi-fee-option]").forEach((option) => {
        const visible = selected.includes(option.dataset.poiId);
        option.hidden = !visible;
        if (!visible) option.querySelector("input").checked = false;
      });
    };
    $$("[data-stop-kind], [data-poi-select]").forEach((select) => select.addEventListener("change", updatePoiFeeOptions));
    updatePoiFeeOptions();

    const quotedStatus = $("[data-quoted-status]");
    const quotedTotal = $("[data-quoted-total]");
    const quoteFingerprint = $("[data-quote-fingerprint]");
    const priceContainer = $("[data-price-container]");
    const quoteStatus = $("[data-quote-status]");
    const ack = $("[data-unresolved-ack]");
    const ackInput = $("#saveWithUnresolvedPrice");
    const summary = {
      root: doc.querySelector("[data-route-summary]"),
      distance: doc.querySelector("[data-route-distance]"),
      duration: doc.querySelector("[data-route-duration]"),
      charges: doc.querySelector("[data-route-charges]"),
      message: doc.querySelector("[data-route-message]"),
      stops: doc.querySelector("[data-route-stops]")
    };
    const map = createMapController(doc);

    const renderQuote = (result) => {
      const route = result ? result.route : null;
      const text = routeSummary(route);
      summary.root.dataset.routeStatus = route ? route.status : "pending";
      summary.distance.textContent = text.distance;
      summary.duration.textContent = text.duration;
      summary.charges.textContent = text.charges;
      summary.message.textContent = text.message;
      summary.stops.innerHTML = result ? stopListHtml(result.stops) : "";
      priceContainer.innerHTML = priceBreakdownHtml(result ? result.price : null);
      quotedStatus.value = result ? result.price.status : "";
      quotedTotal.value = result && result.price.total ? result.price.total : "";
      quoteFingerprint.value = result ? result.fingerprint : "";
      const incomplete = Boolean(result && result.price.status === "incomplete");
      ack.hidden = !incomplete;
      if (!incomplete) ackInput.checked = false;
      map.render(result);
    };

    const journeyReady = () => ["pickup", "dropoff"].every((key) => form.elements[`${key}Kind`].value)
      && form.elements.serviceDate.value && form.elements.serviceTime.value;

    let timer = null;
    let sequence = 0;
    function scheduleQuote() {
      clearTimeout(timer);
      sequence += 1;
      // Any edit invalidates the quote the dispatcher saw until the server recalculates it.
      quotedStatus.value = "";
      quotedTotal.value = "";
      quoteFingerprint.value = "";
      ackInput.checked = false;
      timer = setTimeout(requestQuote, 350);
    }
    function requestQuote() {
      if (!journeyReady()) {
        quoteStatus.textContent = "";
        renderQuote(null);
        return;
      }
      const current = ++sequence;
      quoteStatus.textContent = "Calculating price…";
      fetch("/bookings/quote", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString()
      }).then((response) => response.json().then((body) => ({ ok: response.ok, body }))).then(({ ok, body }) => {
        if (current !== sequence) return;
        if (!ok || !body.ok) {
          renderQuote(null);
          const messages = (body && body.errors ? body.errors : []).map((error) => error.message);
          quoteStatus.textContent = messages.length ? `Price not calculated: ${messages.join(" ")}` : "Price not calculated.";
          return;
        }
        quoteStatus.textContent = "";
        renderQuote(body);
      }).catch(() => {
        if (current !== sequence) return;
        renderQuote(null);
        quoteStatus.textContent = "Price could not be calculated. Saving will recalculate it on the server.";
      });
    }
    form.addEventListener("change", (event) => { if (event.target.matches("[data-quote-input]")) scheduleQuote(); });
    form.addEventListener("input", (event) => { if (event.target.matches("input[data-quote-input]")) scheduleQuote(); });

    wireAddressAutocomplete(form, scheduleQuote);
    requestQuote();
  }

  function wireAddressAutocomplete(form, onSelect) {
    const mapRoot = form.ownerDocument.querySelector("[data-booking-map]");
    const key = mapRoot ? mapRoot.dataset.mapsBrowserKey : "";
    const maps = typeof window !== "undefined" ? window.RideMatrixMaps : null;
    if (!key || !maps || typeof maps.load !== "function") return;
    maps.load(key, [], { libraries: ["places"] }).then(() => window.google.maps.importLibrary("places")).then((places) => {
      if (!places || typeof places.PlaceAutocompleteElement !== "function") return;
      form.querySelectorAll("[data-stop]").forEach((fieldset) => {
        const host = fieldset.querySelector("[data-address-autocomplete-host]");
        const label = fieldset.querySelector("[data-address-label]");
        const placeId = fieldset.querySelector("[data-address-place-id]");
        const status = fieldset.querySelector("[data-address-status]");
        const autocomplete = new places.PlaceAutocompleteElement({ includedRegionCodes: ["gb"] });
        autocomplete.setAttribute("aria-label", `Search Google Places for the ${fieldset.querySelector("legend").textContent.trim()} address`);
        host.appendChild(autocomplete);
        autocomplete.addEventListener("gmp-select", (event) => {
          const prediction = event && (event.placePrediction || (event.detail && event.detail.placePrediction));
          if (!prediction || typeof prediction.toPlace !== "function") return;
          const place = prediction.toPlace();
          Promise.resolve(place.fetchFields({ fields: ["id", "displayName", "formattedAddress", "location"] })).then(() => {
            if (!place.id) return;
            label.value = place.formattedAddress || (place.displayName && place.displayName.text) || place.displayName || "";
            placeId.value = place.id;
            status.textContent = "Google Place selected. Coordinates and postcode are verified on the server.";
            onSelect();
          }).catch(() => { status.textContent = "The selected Google Place could not be loaded. Choose another result."; });
        });
      });
    }).catch(() => {});
  }

  function createMapController(doc) {
    const root = doc.querySelector("[data-booking-map]");
    const canvas = doc.querySelector("[data-booking-map-canvas]");
    const unavailable = doc.querySelector("[data-booking-map-unavailable]");
    const key = root ? root.dataset.mapsBrowserKey : "";
    let mapPromise = null;
    let overlays = [];
    const showUnavailable = (message) => {
      if (canvas) canvas.hidden = true;
      if (unavailable) {
        unavailable.hidden = false;
        if (message) unavailable.textContent = message;
      }
    };
    const getMap = () => {
      if (!key || typeof window === "undefined" || !window.RideMatrixMaps) return Promise.resolve(null);
      if (!mapPromise) {
        mapPromise = window.RideMatrixMaps.load(key, [], { libraries: [] })
          .then(() => window.google.maps.importLibrary("maps"))
          .then((library) => new library.Map(canvas, {
            center: { lat: 51.5074, lng: -0.1278 },
            zoom: 9,
            mapId: root.dataset.mapsMapId || undefined,
            streetViewControl: false
          }))
          .catch(() => {
            showUnavailable("Map unavailable: Google Maps could not be loaded. The ordered stops are listed below.");
            return null;
          });
      }
      return mapPromise;
    };
    const render = (result) => {
      getMap().then((map) => {
        if (!map) return;
        overlays.forEach((overlay) => overlay.setMap(null));
        overlays = [];
        if (!result) return;
        const bounds = new window.google.maps.LatLngBounds();
        result.stops.forEach((stop, index) => {
          if (stop.latitude === null || stop.longitude === null) return;
          const position = { lat: Number(stop.latitude), lng: Number(stop.longitude) };
          overlays.push(new window.google.maps.Marker({ map, position, label: String(index + 1), title: stop.label }));
          bounds.extend(position);
        });
        if (result.route && result.route.status === "resolved" && result.route.path.length) {
          const path = result.route.path.map(([lat, lng]) => ({ lat, lng }));
          overlays.push(new window.google.maps.Polyline({ map, path, strokeColor: "#1d4ed8", strokeWeight: 4 }));
          path.forEach((point) => bounds.extend(point));
        }
        if (!bounds.isEmpty()) map.fitBounds(bounds);
      });
    };
    return { render };
  }

  return {
    cargoSummary,
    passengerState,
    formatDuration,
    activeStopKeys,
    nextViaToAdd,
    removeVia,
    routeSummary,
    priceBreakdownHtml,
    init
  };
});
