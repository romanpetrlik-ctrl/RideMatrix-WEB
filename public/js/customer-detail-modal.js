(function () {
  "use strict";

  var modal = document.querySelector("[data-customer-detail-modal]");
  if (!modal) return;
  var content = modal.querySelector("[data-customer-detail-modal-content]");
  var trigger = null;

  function close() {
    if (modal.open) modal.close();
    document.body.classList.remove("modal-open");
    if (trigger) trigger.focus();
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest("[data-customer-detail-trigger]");
    if (!link) return;
    event.preventDefault();
    trigger = link;
    content.setAttribute("aria-busy", "true");
    content.textContent = "Loading customer detail…";
    fetch(link.href + (link.href.indexOf("?") === -1 ? "?" : "&") + "fragment=1")
      .then(function (response) {
        if (!response.ok) throw new Error("Customer detail unavailable");
        return response.text();
      })
      .then(function (html) {
        content.innerHTML = html;
        content.removeAttribute("aria-busy");
        modal.showModal();
        document.body.classList.add("modal-open");
        var closeButton = modal.querySelector("[data-customer-modal-close]");
        if (closeButton) closeButton.focus();
      })
      .catch(function () {
        window.location.href = link.href;
      });
  });

  modal.addEventListener("click", function (event) {
    if (event.target === modal || event.target.closest("[data-customer-modal-close]")) close();
  });
  modal.addEventListener("cancel", function (event) {
    event.preventDefault();
    close();
  });
}());
