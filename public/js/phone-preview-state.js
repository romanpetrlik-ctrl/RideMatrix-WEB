/*
 * Browser build of src/services/phone-preview-state.ts.
 * Keep the logic in sync with that module; the unit tests in
 * src/services/phone-preview-state.test.ts load this file and verify
 * the exposed tracker behaviour.
 */
"use strict";
(function () {
  function createPhonePreviewTracker() {
    var requestId = 0;
    var value = "";

    return {
      trackRequest: function (nextValue) {
        requestId += 1;
        value = nextValue;
        return { requestId: requestId, value: value };
      },
      isCurrent: function (snapshot) {
        return snapshot.requestId === requestId && snapshot.value === value;
      },
      resolve: function (snapshot, preview) {
        return this.isCurrent(snapshot) ? preview : null;
      }
    };
  }

  window.PhonePreviewState = { createPhonePreviewTracker: createPhonePreviewTracker };
}());
