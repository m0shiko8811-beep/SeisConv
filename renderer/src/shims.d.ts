// Ambient module shims for non-code imports bundled by esbuild.
// Leaflet ships a stylesheet we import for its side effects; esbuild emits it
// to renderer/dist/app.css. tsc only needs to know the module exists.
declare module '*.css';

// `leaflet-rotate` is a side-effect plugin (no bundled type defs). It augments
// the global L at runtime; we only import it for its effects.
declare module 'leaflet-rotate';

// Type augmentation for the rotation API leaflet-rotate adds to L.Map and the
// extra map-construction options it understands.
import 'leaflet';
declare module 'leaflet' {
  interface MapOptions {
    /** Enable rotation support (creates a rotate pane). */
    rotate?: boolean;
    /** Initial bearing in degrees (clockwise). */
    bearing?: number;
    /** Built-in rotate control - we supply our own UI, so disable it. */
    rotateControl?: boolean | object;
    /** Optional Shift+wheel rotation gesture. */
    shiftKeyRotate?: boolean;
  }
  interface Map {
    /** Rotate the map to `deg` (clockwise, degrees). */
    setBearing(deg: number): this;
    /** Current bearing in degrees (clockwise). */
    getBearing(): number;
  }
}
