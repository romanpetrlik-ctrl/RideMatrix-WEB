(function () {
  "use strict";

  var CLOSE_MESSAGE = "ridematrix:customer-detail-close";
  var ACCEPTED_MESSAGE = "ridematrix:customer-detail-close-accepted";
  var detailWindows = [];
  var origin = window.location.origin;

  function validReturnPath(path) {
    return typeof path === "string"
      && (path === "/customers" || path.indexOf("/customers?") === 0)
      && !path.startsWith("//");
  }

  function showFallback() {
    var fallback = document.querySelector("[data-close-detail-fallback]");
    if (fallback) fallback.hidden = false;
  }

  document.querySelectorAll("[data-customer-detail-link]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      if (event.defaultPrevented) return;
      var child = window.open(link.href, "_blank");
      if (child) {
        detailWindows.push(child);
        event.preventDefault();
      }
    });
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin || event.data === null || event.data.type !== CLOSE_MESSAGE) return;
    if (detailWindows.indexOf(event.source) === -1 || !validReturnPath(event.data.returnPath)) return;
    event.source.postMessage({ type: ACCEPTED_MESSAGE }, origin);
    window.location.assign(event.data.returnPath);
  });

  var closeButton = document.querySelector("[data-close-detail-window]");
  if (!closeButton) return;

  closeButton.addEventListener("click", function () {
    var openerOrigin = "";
    try {
      openerOrigin = window.opener && window.opener.location.origin;
    } catch (_error) {
      openerOrigin = "";
    }
    if (!window.opener || window.opener.closed || openerOrigin !== origin) {
      showFallback();
      return;
    }

    var accepted = false;
    function onAccepted(event) {
      if (event.origin !== origin || event.source !== window.opener || !event.data || event.data.type !== ACCEPTED_MESSAGE) return;
      accepted = true;
      window.removeEventListener("message", onAccepted);
      window.close();
      window.setTimeout(function () { if (!accepted || !window.closed) showFallback(); }, 250);
    }
    window.addEventListener("message", onAccepted);
    window.opener.postMessage({
      type: CLOSE_MESSAGE,
      returnPath: "/customers"
    }, origin);
    window.setTimeout(function () {
      if (!accepted) {
        window.removeEventListener("message", onAccepted);
        showFallback();
      }
    }, 1000);
  });
}());
