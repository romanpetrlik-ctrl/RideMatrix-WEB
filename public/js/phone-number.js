(function () {
  var flagForIso = window.PhoneFlags && window.PhoneFlags.flagForIso
    ? window.PhoneFlags.flagForIso
    : function () { return "🌐"; };

  var phonePreviewStateFactory = window.PhonePreviewState && window.PhonePreviewState.createPhonePreviewTracker
    ? window.PhonePreviewState.createPhonePreviewTracker
    : function () {
        return {
          trackRequest: function (value) { return { value: value }; },
          resolve: function (_snapshot, preview) { return preview; }
        };
      };

  var UK_E164_RE = /^\+44\d{10}$/;
  var E164_RE = /^\+[1-9]\d{7,14}$/;

  function normalizeUkFallback(raw) {
    var v = (raw || "").trim().replace(/[^\d+]/g, "");
    if (!v) return null;

    if (v.indexOf("00") === 0) v = "+" + v.slice(2);

    if (v.indexOf("+44") === 0) {
      var rest = v.slice(3);
      return /^\d{10}$/.test(rest) ? "+44" + rest : null;
    }

    if (v.indexOf("44") === 0 && /^\d{12}$/.test(v)) return "+" + v;
    if (v.charAt(0) === "0" && /^\d{11}$/.test(v)) return "+44" + v.slice(1);

    return null;
  }

  function fallbackPreview(raw) {
    var normalized = normalizeUkFallback(raw);
    if (!normalized) return { valid: false };
    return {
      valid: true,
      normalized: normalized,
      country: { isoCode: "GB", countryName: "United Kingdom", callingCode: "+44" },
      telHref: "tel:" + normalized,
      whatsappHref: "https://wa.me/" + normalized.slice(1)
    };
  }

  document.querySelectorAll("[data-phone-number]").forEach(function (component) {
    var input = component.querySelector("[data-phone-input]");
    var flag = component.querySelector("[data-phone-flag]");
    var country = component.querySelector("[data-phone-country]");
    var error = component.querySelector("[data-phone-error]");
    var form = input ? input.closest("form") : null;
    var actions = form && form.querySelector("[data-phone-actions]");
    var email = actions && actions.querySelector("[data-phone-email]");
    var tel = actions && actions.querySelector("[data-phone-tel]");
    var whatsapp = actions && actions.querySelector("[data-phone-whatsapp]");
    var emailInput = form && form.querySelector('input[type="email"]');
    var timer;
    var state = null;
    var tracker = phonePreviewStateFactory();

    if (!input || !flag || !country || !error) return;

    function hasUsableEmail() {
      var value = emailInput && emailInput.value ? emailInput.value.trim() : "";
      return Boolean(value && emailInput && emailInput.checkValidity && emailInput.checkValidity());
    }

    function renderActions() {
      if (!actions || !email || !tel || !whatsapp) return;

      var validPhone = Boolean(state && state.valid);
      var validEmail = hasUsableEmail();

      email.hidden = !validEmail;
      tel.hidden = !validPhone;
      whatsapp.hidden = !validPhone;
      actions.hidden = !validEmail && !validPhone;

      if (validEmail) {
        email.href = "mailto:" + encodeURIComponent(emailInput.value.trim()).replace(/%40/g, "@");
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
      var valueNow = (input.value || "").trim();
      var previewNormalized = preview && preview.normalized ? String(preview.normalized) : "";
      var fallbackNormalized = normalizeUkFallback(valueNow);
      var finalNormalized = previewNormalized || fallbackNormalized || (E164_RE.test(valueNow) ? valueNow : "");

      var valid = Boolean(
        (preview && preview.valid === true) ||
        UK_E164_RE.test(finalNormalized) ||
        (E164_RE.test(finalNormalized) && finalNormalized.indexOf("+44") === 0)
      );

      state = valid
        ? {
            valid: true,
            normalized: finalNormalized,
            country: (preview && preview.country) || { isoCode: "GB", countryName: "United Kingdom", callingCode: "+44" },
            telHref: "tel:" + finalNormalized,
            whatsappHref: "https://wa.me/" + finalNormalized.replace(/^\+/, "")
          }
        : { valid: false };

      var hasValue = Boolean((input.value || "").trim());
      input.setCustomValidity("");
      var actuallyInvalid = hasValue && !input.checkValidity();
      error.hidden = true;

      if (valid) {
        if (finalNormalized && input.value !== finalNormalized) input.value = finalNormalized;

        var iso = state.country && state.country.isoCode ? state.country.isoCode : "GB";
        var emoji = flagForIso(iso);
        flag.textContent = emoji && emoji !== "🌐" ? emoji : "🇬🇧";

        country.textContent = (state.country.countryName || "United Kingdom") + " (" + (state.country.callingCode || "+44") + ")";
        country.title = country.textContent;
        country.setAttribute("aria-label", country.textContent);
<<<<<<< Updated upstream
        if (tel) tel.href = preview.telHref;
        if (whatsapp) whatsapp.href = preview.whatsappHref;
=======
>>>>>>> Stashed changes
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

      var snapshot = tracker.trackRequest(input.value);
      state = null;
      input.setCustomValidity("");
      error.hidden = true;
      renderActions();

      if (!input.value.trim()) {
        render({ valid: false });
        return;
      }

      timer = setTimeout(function () {
        fetch("/customers/phone-preview?value=" + encodeURIComponent(snapshot.value), {
          headers: { Accept: "application/json" }
        })
          .then(function (response) {
            var contentType = response.headers && response.headers.get ? (response.headers.get("content-type") || "") : "";
            if (!response.ok || contentType.indexOf("application/json") === -1) return null;
            return response.json();
          })
          .then(function (previewResult) {
            if (!previewResult || typeof previewResult.valid !== "boolean") {
              previewResult = fallbackPreview(snapshot.value);
            }
            var current = tracker.resolve(snapshot, previewResult);
            if (current !== null) render(current);
          })
          .catch(function () {
            var current = tracker.resolve(snapshot, fallbackPreview(snapshot.value));
            if (current !== null) render(current);
          });
      }, 120);
    }

    input.addEventListener("input", preview);
    input.addEventListener("blur", preview);

    if (emailInput) {
      emailInput.addEventListener("input", renderActions);
      emailInput.addEventListener("change", renderActions);
    }

<<<<<<< Updated upstream
    if (form) {
      form.addEventListener("submit", function (event) {
        if (!input.required && !input.value.trim()) {
          input.setCustomValidity("");
          return;
        }
        if (!state || !state.valid) {
          event.preventDefault();
          input.setCustomValidity("Phone number is not valid.");
          input.reportValidity();
          return;
        }
        input.value = state.normalized;
      });
    }
=======
    preview();
>>>>>>> Stashed changes
  });
}());