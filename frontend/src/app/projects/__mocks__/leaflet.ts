/**
 * Vitest manual mock for Leaflet (issue #1335).
 *
 * Placed in __mocks__/leaflet.ts adjacent to the component that imports it.
 * Vite resolves this automatically when tests run under vitest, so the
 * project-map spec never tries to load the real library.
 */
export const map = () => ({
  remove: () => {},
  addLayer: () => {},
  setView: () => {},
  fitBounds: () => {},
});

export const tileLayer = () => ({ addTo: () => {} });

export const circleMarker = () => ({
  bindPopup: function () { return this; },
  on: function () { return this; },
  addTo: function () { return this; },
});

export const layerGroup = () => ({
  addLayer: function () { return this; },
  addTo: function () { return this; },
});

export default { map, tileLayer, circleMarker, layerGroup };
