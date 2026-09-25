/**
 * api-base.js — interim API routing for clinic.fideantech.com.
 * Routes relative /api/* calls to the temporary Cloudflare tunnel backend.
 */
(function () {
  const API_BASE = window.location.origin;
  const originalFetch = window.fetch.bind(window);

  window.fetch = function patchedClinicFetch(input, init) {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      input = API_BASE + input;
    } else if (input instanceof Request && input.url.startsWith(window.location.origin + '/api/')) {
      input = new Request(API_BASE + input.url.slice(window.location.origin.length), input);
    }
    return originalFetch(input, init);
  };

  window.CLINIC_API_BASE = API_BASE;
})();
