/**
 * 64-bit hashing primitives used by weighted Rendezvous hashing.
 *
 * The default hash is FNV-1a 64-bit followed by the SplitMix64 finalizer.
 * FNV-1a alone has poor bit mixing (e.g. nearly-identical strings hash to
 * nearly-identical values), which matters because a key is combined with
 * every node id. The SplitMix64 finalizer gives the stream a strong avalanche
 * while staying dependency-free and fully deterministic across processes.
 *
 * All arithmetic is done in native `bigint`, so results are identical
 * regardless of platform (floating-point is never used for hashing).
 */
export const U64_MASK = (1n << 64n) - 1n;
export const U64_WRAP = 1n << 64n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
/** FNV-1a, 64-bit, over the UTF-8 encoding of `input`. */
export function fnv1a64(input) {
    const bytes = Buffer.from(input, 'utf8');
    let hash = FNV_OFFSET;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= BigInt(bytes[i]);
        hash = (hash * FNV_PRIME) & U64_MASK;
    }
    return hash;
}
/**
 * SplitMix64 finalizer (Vigna). Produces a well-mixed unsigned 64-bit value
 * from a 64-bit seed. `state` is folded into 64 bits first, so callers may
 * pass any non-negative BigInt.
 */
export function splitmix64(state) {
    let z = (state & U64_MASK) + 0x9e3779b97f4a7c15n;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
    return z ^ (z >> 31n);
}
/**
 * Frame a key together with a node id into one unambiguous string.
 *
 * Layout: decimal UTF-16 length of the key, one ':' separator, the key
 * itself, then the node id: `"<len>:<key><nodeId>"`.
 *
 * This is injective: in any framed string the first ':' sits at a fixed
 * position, the digits before it uniquely determine the key's length, so
 * the boundary between key and node id cannot be shifted by content that
 * happens to contain ':' or any other character (no escaping needed).
 */
export function frameKeyAndNodeId(key, nodeId) {
    return key.length.toString(10) + ':' + key + nodeId;
}
/**
 * Default hash used by the router.
 *
 * Deterministic, dependency-free, and safe to replace with a faster
 * implementation (xxhash64, CityHash64, a platform-accelerated hash, ...)
 * by passing it to the `RendezvousRouter` constructor.
 */
export const defaultHash64 = (input) => splitmix64(fnv1a64(input));
/**
 * Map an unsigned 64-bit hash value to a double in the open interval
 * (0, 1). The low 52 bits (`v`) are taken and mapped as:
 *
 *   u = (v + 1) / (2^52 + 2)
 *
 * The 52-bit (rather than 53-bit) range plus the padded denominator
 * guarantees that both endpoints round *away* from 0 and 1 in IEEE-754
 * double precision (the naive `(v+1)/2^53` mapping rounds its upper end to
 * exactly 1 because a double 2^-53 below 1 ties to even toward 1). Hence
 * `-ln(u)` is always a finite, strictly positive number.
 */
export function uniform01(hash) {
    const value = hash & ((1n << 52n) - 1n);
    return Number(value + 1n) / 4503599627370498; // 2^52 + 2
}
/**
 * Weighted Rendezvous score for one (key, node) pair.
 *
 *   score = weight / -ln(u),  with u = uniform01(hash(key, nodeId)) in (0, 1)
 *
 * This is the classic "weighted Rendezvous" variant (weight divided by the
 * exponential variate): for any fixed key, the probability that a node is
 * the argmax is proportional to its weight. Higher score wins.
 *
 * `weight` must be a finite, strictly positive number.
 */
export function rendezvousScore(hash, weight) {
    if (!Number.isFinite(weight) || weight <= 0) {
        throw new TypeError('weight must be a finite positive number');
    }
    const u = uniform01(hash);
    return weight / -Math.log(u);
}
//# sourceMappingURL=hash.js.map