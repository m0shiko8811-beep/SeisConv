// Side-effect module that wires up the `leaflet-rotate` plugin.
//
// `leaflet-rotate` augments the GLOBAL `L` object (it does
// `L.Map.include({ setBearing, getBearing, ... })`). Our renderer is bundled by
// esbuild as an IIFE where `import L from 'leaflet'` does NOT create a
// window-level `L`, so the plugin would otherwise find no `L` to extend.
//
// `./leaflet-global` publishes the active Leaflet instance on `globalThis`.
// Because esbuild evaluates a module's imports depth-first IN ORDER, importing
// the global-setter BEFORE the plugin guarantees `globalThis.L` is set before
// the plugin's module body runs and extends it.
import './leaflet-global';

// eslint-disable-next-line import/no-unresolved -- no bundled type defs
import 'leaflet-rotate';

export {};
