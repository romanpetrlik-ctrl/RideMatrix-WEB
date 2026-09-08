/**
 * Request sequencing guard for the asynchronous phone-number preview.
 *
 * The phone preview endpoint is debounced, but responses can still resolve
 * out of order: a request for an older input value may finish after the
 * request for the newest value. This helper tracks the latest request
 * sequence and the input value it belongs to so the component can ignore
 * stale responses instead of applying them over newer state.
 *
 * The browser bundle built from this module is served as
 * /js/phone-preview-state.js and consumed by public/js/phone-number.js via
 * `window.PhonePreviewState.createPhonePreviewTracker`.
 */

export interface PhonePreviewSnapshot {
  requestId: number;
  value: string;
}

export interface PhonePreviewTracker {
  /**
   * Registers the input value a preview request is about to be sent for and
   * returns a snapshot that uniquely identifies that request.
   */
  trackRequest(value: string): PhonePreviewSnapshot;
  /**
   * Returns true only when the snapshot belongs to the most recently tracked
   * request and the input value has not changed since.
   */
  isCurrent(snapshot: PhonePreviewSnapshot): boolean;
  /**
   * Discards the snapshot when it no longer matches the current value, and
   * returns the preview unchanged when it is still current.
   */
  resolve<T>(snapshot: PhonePreviewSnapshot, preview: T): T | null;
}

export function createPhonePreviewTracker(): PhonePreviewTracker {
  let requestId = 0;
  let value = "";

  return {
    trackRequest(nextValue: string): PhonePreviewSnapshot {
      requestId += 1;
      value = nextValue;
      return { requestId, value };
    },
    isCurrent(snapshot: PhonePreviewSnapshot): boolean {
      return snapshot.requestId === requestId && snapshot.value === value;
    },
    resolve<T>(snapshot: PhonePreviewSnapshot, preview: T): T | null {
      return this.isCurrent(snapshot) ? preview : null;
    }
  };
}
