/*
 * Cross-origin isolation bridge for WebAssembly pthreads.
 *
 * Websim's static page server does not expose COOP/COEP response headers, but
 * the browser can apply the same policy to controlled responses through a
 * same-origin service worker. This enables SharedArrayBuffer on the reload
 * after the worker becomes the page controller.
 */
// Chrome's documented COI path uses require-corp. This is stricter than
// credentialless, but it makes missing CORS/CORP resources fail visibly
// instead of silently falling back to a non-isolated page.
let credentialless = false;

if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (event) => {
    if (event.data?.type === "coepCredentialless") credentialless = event.data.value === true;
    if (event.data?.type === "deregister") {
      event.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => clients.forEach((client) => client.navigate(client.url))));
    }
  });

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
    const isolatedRequest = credentialless && request.mode === "no-cors"
      ? new Request(request, { credentials: "omit" })
      : request;
    event.respondWith(fetch(isolatedRequest).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", credentialless ? "credentialless" : "require-corp");
      if (!credentialless) headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }).catch((error) => {
      console.error("COI service worker fetch failed", error);
      return Response.error();
    }));
  });
} else {
  (() => {
    const navigation = navigator.serviceWorker;
    if (!navigation || window.crossOriginIsolated !== false || !window.isSecureContext) return;
    // Websim injects WebsimSocket from the host-authority context. If a
    // previous isolated reload proved that integration unavailable, stay
    // disabled for this tab so realtime multiplayer can recover cleanly.
    if (sessionStorage.getItem("gauntlet-coi-disabled-for-realtime") === "1") {
      navigation.controller?.postMessage({ type: "deregister" });
      return;
    }

    navigation.register(document.currentScript.src).then((registration) => navigator.serviceWorker.ready.then((readyRegistration) => {
      const controller = navigation.controller || readyRegistration.active || registration.active;
      controller?.postMessage({ type: "coepCredentialless", value: false });
      // clients.claim() may make the worker a controller before this document
      // has received the isolation headers. Reload exactly once in that case;
      // if the host disallows header rewriting, do not trap the app in a loop.
      const reloadKey = "gauntlet-coi-reload-attempted";
      if (readyRegistration.active && !window.crossOriginIsolated && !sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, "1");
        console.info("COI service worker installed; reloading for threaded WASM");
        window.location.reload();
      }
    })).catch((error) => console.warn("COI service worker unavailable", error));
  })();
}
