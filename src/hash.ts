import type { Hash64 } from "./types.js";

/**
 * Default 64-bit hash: FNV-1a (64 bit) over the UTF-16 code units of the
 * message, passed through the SplitMix64 finalizer.
 *
 * FNV-1a by itself has visibly non-uniform low-order structure for short
 * sequential inputs (e.g. "key:0", "key:1", ...); the SplitMix64 mixer
 * avalanches every bit so the resulting scores are well distributed while
 * the whole computation stays a small, dependency-free BigInt routine.
 *
 * The hash is fully deterministic and therefore stable across processes,
 * Node versions and machines (independent of V8's randomized hash seeds).
 */
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function splitMix64(z: bigint): bigint {
  z = (z + 0x9e3779b97f4a7c15n) & MASK_64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  return (z ^ (z >> 31n)) & MASK_64;
}

export const fnv1a64: Hash64 = (message: string): bigint => {
  let hash = FNV_OFFSET_64;
  // Code units (not UTF-8 bytes) keep hashing independent of encoding APIs
  // and give an injective, unambiguous mapping to the JS string.
  for (let i = 0; i < message.length; i++) {
    hash ^= BigInt(message.charCodeAt(i));
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return splitMix64(hash);
};

/**
 * Normalize a 64-bit hash result (number or bigint) into an unsigned 64-bit
 * bigint. Negative values are reinterpreted as their two's-complement
 * unsigned counterpart.
 */
export function toUint64(value: number | bigint): bigint {
  if (typeof value === "bigint") {
    return BigInt.asUintN(64, value);
  }
  if (!Number.isFinite(value)) {
    throw new TypeError("Hash function returned a non-finite number");
  }
  return BigInt.asUintN(64, BigInt(Math.trunc(value)));
}

/**
 * Map an unsigned 64-bit hash value to the half-open interval [0, 1).
 *
 * Dividing by 2^64 with the top 33 bits keeps all 33 bits of precision
 * (2^33 < 2^53, the exact-integer limit of a JS number). The value 1.0 can
 * never be produced because the numerator is strictly smaller than 2^33.
 */
export function unitInterval64(hash: bigint): number {
  const TOP_BITS = 0x800000000n; // 2^33
  return Number(hash >> 31n) / Number(TOP_BITS);
}
