(function () {
  "use strict";
  var required = document.getElementById("bookingAuthRequired");
  var channel = document.getElementById("bookingAuthChannel");
  if (!required || !channel) return;
  function updateChannel() {
    channel.required = required.value === "yes";
    channel.disabled = required.value !== "yes";
  }
  required.addEventListener("change", updateChannel);
  updateChannel();
}());
