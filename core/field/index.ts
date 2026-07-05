// seisconv-core/field — WiFiSync pure-algorithm barrel.
//
// Everything here is framework-free and unit-testable (no fs / net / dgram /
// electron). The socket ENGINE that uses these lives in electron/field and is
// intentionally NOT re-exported from core (it pulls Node net/dgram/fs).
//
// Wire-compatible with the live Python WiFiSync app: same UDP/TCP ports, same
// big-endian frames, same mtime (float64 epoch seconds) semantics.

export * from './types';
export * from './constants';
export * from './safepath';
export * from './ratelimit';
export * from './manifest';
export * from './diff';
export * from './roles';
export * from './discovery-packet';
export * from './transfer-frame';
