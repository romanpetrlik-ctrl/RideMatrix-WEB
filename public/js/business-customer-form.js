(function () {
  "use strict";
  var required = document.getElementById("bookingAuthRequired");
  var channel = document.getElementById("bookingAuthChannel");
  if (required && channel) {
    var updateChannel = function () {
      channel.required = required.value === "yes";
      channel.disabled = required.value !== "yes";
    };
    required.addEventListener("change", updateChannel);
    updateChannel();
  }

  var form = document.getElementById("business-customer-form");
  var summary = form && form.querySelector("[data-error-summary]");
  var summaryList = summary && summary.querySelector("[data-error-summary-list]");
  if (!form || !summary || !summaryList) return;

  // Validation is reported through the error summary and inline messages
  // instead of the browser's transient validation bubbles.
  form.noValidate = true;

  function labelFor(control) {
    var label = control.id ? form.querySelector('label[for="' + control.id + '"]') : null;
    return ((label && label.textContent) || control.name || "This field").replace(/\s*\*\s*$/, "").trim();
  }

  function messageFor(control) {
    var label = labelFor(control);
    if (control.validity.customError) return control.validationMessage;
    if (control.validity.valueMissing) return label + " is required.";
    if (control.validity.typeMismatch && control.type === "email") return label + " must be a valid email address.";
    return label + ": " + control.validationMessage;
  }

  function errorElementFor(control, create) {
    var existing = document.getElementById(control.id + "-error");
    if (existing || !create) return existing;
    var element = document.createElement("p");
    element.className = "form-field__error";
    element.id = control.id + "-error";
    control.insertAdjacentElement("afterend", element);
    return element;
  }

  function setDescribedBy(control, errorId, add) {
    var ids = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean)
      .filter(function (id) { return id !== errorId; });
    if (add) ids.push(errorId);
    if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
    else control.removeAttribute("aria-describedby");
  }

  function isPhone(control) {
    return control.hasAttribute("data-phone-input");
  }

  function clearInline(control) {
    control.removeAttribute("aria-invalid");
    if (isPhone(control)) return;
    var element = errorElementFor(control, false);
    if (element) {
      element.hidden = true;
      element.textContent = "";
      setDescribedBy(control, element.id, false);
    }
  }

  function showInline(control, message) {
    control.setAttribute("aria-invalid", "true");
    // Phone components render their own inline message.
    if (isPhone(control)) return;
    var element = errorElementFor(control, true);
    element.textContent = message;
    element.hidden = false;
    setDescribedBy(control, element.id, true);
  }

  function focusField(id) {
    var control = document.getElementById(id);
    if (!control) return false;
    control.focus();
    return true;
  }

  summaryList.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[data-error-field]") : null;
    if (link && focusField(link.getAttribute("data-error-field"))) event.preventDefault();
  });

  function controls() {
    return Array.prototype.filter.call(form.elements, function (control) {
      return control.id && control.willValidate;
    });
  }

  controls().forEach(function (control) {
    function revalidate() {
      if (control.getAttribute("aria-invalid") === "true" && control.validity.valid) clearInline(control);
    }
    control.addEventListener("input", revalidate);
    control.addEventListener("change", revalidate);
  });

  form.addEventListener("submit", function (event) {
    var invalid = [];
    controls().forEach(function (control) {
      if (control.validity.valid) {
        clearInline(control);
      } else {
        var message = messageFor(control);
        invalid.push({ control: control, message: message });
        showInline(control, message);
      }
    });

    if (!invalid.length) {
      // A phone preview may still be resolving; the phone component resubmits.
      if (!event.defaultPrevented) summary.hidden = true;
      return;
    }

    event.preventDefault();
    summaryList.textContent = "";
    invalid.forEach(function (item) {
      var entry = document.createElement("li");
      var link = document.createElement("a");
      link.href = "#" + item.control.id;
      link.setAttribute("data-error-field", item.control.id);
      link.textContent = item.message;
      entry.appendChild(link);
      summaryList.appendChild(entry);
    });
    summary.hidden = false;
    summary.focus();
  });

  if (!summary.hidden) summary.focus();
}());
