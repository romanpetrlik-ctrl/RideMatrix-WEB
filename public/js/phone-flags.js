"use strict";
(function () {
  function flagForIso(isoCode) {
    var code = String(isoCode || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      return "🌐";
    }

    try {
      var countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
      if (!countryName || countryName === code || countryName === "Unknown Region") {
        return "🌐";
      }
    } catch (_error) {
      return "🌐";
    }

    return code.replace(/[A-Z]/g, function (letter) {
      return String.fromCodePoint(letter.charCodeAt(0) + 127397);
    });
  }

  window.PhoneFlags = { flagForIso: flagForIso };
}());
