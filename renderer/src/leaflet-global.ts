// Expose the renderer's Leaflet instance on `globalThis` so side-effect plugins
// (e.g. leaflet-rotate) that extend the GLOBAL `L` augment the same instance we
// import. This module does ONE thing and is imported before any such plugin so
// the assignment runs first (esbuild evaluates dependencies depth-first).
import L from 'leaflet';

(globalThis as unknown as { L: typeof L }).L = L;

export {};
