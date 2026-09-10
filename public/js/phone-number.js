(function () {
  function flagForIso(isoCode) {
    return isoCode
      ? isoCode.toUpperCase().replace(/[A-Z]/g, function (letter) {
          return String.fromCodePoint(letter.charCodeAt(0) + 127397);
        })
      : "🌐";
  }

  document.querySelectorAll("[data-phone-number]").forEach(function (component) {
    var input = component.querySelector("[data-phone-input]");
    var flag = component.querySelector("[data-phone-flag]");
    var country = component.querySelector("[data-phone-country]");
    var error = component.querySelector("[data-phone-error]");
    var actions = component.querySelector("[data-phone-actions]");
    var email = component.querySelector("[data-phone-email]");
    var tel = component.querySelector("[data-phone-tel]");
    var whatsapp = component.querySelector("[data-phone-whatsapp]");
    var form = input.closest("form");
    var emailInput = form && form.querySelector('input[type="email"]');
    var timer;
    var state = null;
    var tracker = window.PhonePreviewState.createPhonePreviewTracker();

    function hasUsableEmail() {
      var value = emailInput && emailInput.value.trim();
      return Boolean(value && emailInput.checkValidity());
    }

    function renderActions() {
      var validPhone = Boolean(state && state.valid);
      var validEmail = hasUsableEmail();
      email.hidden = !validEmail;
      tel.hidden = !validPhone;
      whatsapp.hidden = !validPhone;
      actions.hidden = !validEmail && !validPhone;
      if (validEmail) {
        email.href = "mailto:" + encodeURI(emailInput.value.trim());
      } else {
        email.removeAttribute("href");
      }
      if (validPhone) {
        tel.href = state.telHref;
        whatsapp.href = state.whatsappHref;
      } else {
        tel.removeAttribute("href");
        whatsapp.removeAttribute("href");
      }
    }

    function render(preview) {
      state = preview;
      var valid = preview && preview.valid;
      error.hidden = !input.value || valid;
      input.setCustomValidity(input.value && !valid ? "Phone number is not valid." : "");
      if (valid) {
        if (preview.normalized && input.value !== preview.normalized) {
          input.value = preview.normalized;
        }
        flag.textContent = flagForIso(preview.country.isoCode);
        country.textContent = preview.country.countryName + " (" + preview.country.callingCode + ")";
        country.title = country.textContent;
        country.setAttribute("aria-label", country.textContent);
        tel.href = preview.telHref;
        whatsapp.href = preview.whatsappHref;
      } else {
        flag.textContent = "🌐";
        country.textContent = "Enter a phone number";
        country.removeAttribute("title");
        country.removeAttribute("aria-label");
      }
      renderActions();
    }

    function preview() {
      clearTimeout(timer);
      if (!input.value.trim()) {
        tracker.trackRequest(input.value);
        render({ valid: false });
        return;
      }
      timer = setTimeout(function () {
        var snapshot = tracker.trackRequest(input.value);
        fetch("/customers/phone-preview?value=" + encodeURIComponent(snapshot.value), {
          headers: { Accept: "application/json" }
        })
          .then(function (response) { return response.ok ? response.json() : { valid: false }; })
          .then(function (previewResult) {
            if (!input.value.trim()) {
              tracker.trackRequest(input.value);
              render({ valid: false });
              return;
            }
            var current = tracker.resolve(snapshot, previewResult);
            if (current === null) {
              return;
            }
            if (current.valid && current.normalized) {
              input.value = current.normalized;
              tracker.trackRequest(current.normalized);
            }
            render(current);
          })
          .catch(function () {
            var current = tracker.resolve(snapshot, { valid: false });
            if (current !== null) {
              render(current);
            }
          });
      }, 150);
    }

    input.addEventListener("input", preview);
    input.addEventListener("blur", preview);
    if (emailInput) {
      emailInput.addEventListener("input", renderActions);
      emailInput.addEventListener("change", renderActions);
    }
    preview();

    if (form) {
      form.addEventListener("submit", function (event) {
        if (!state || !state.valid) {
          event.preventDefault();
          input.setCustomValidity("Phone number is not valid.");
          input.reportValidity();
          return;
        }
        input.value = state.normalized;
      });
    }
  });
}());
