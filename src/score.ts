import { fnv1a64, toUint64, unitInterval64 } from "./hash.js";
import type { Hash64, NodeInput, NodeView } from "./types.js";

/**
 * Build the unambiguous message fed to the hash function.
 *
 * Layout (all values are UTF-16 code units; length prefixes are four bytes
 * encoded little-endian as code units 0..255):
 *
 *   uint32 LE | key        | uint32 LE | id
 *   len(key)  | key units  | len(id)   | id units
 *
 * Length-prefixing both strings makes the encoding injective: concatenations
 * like ("a", "bc") and ("ab", "c") cannot collide, and a key can never be
 * parsed as part of an id. Only key and node id participate — weights,
 * domains and tags deliberately do not, so relabeling metadata never moves
 * keys.
 */
export function buildMessage(key: string, nodeId: string): string {
  const encodeLength = (length: number): string =>
    String.fromCharCode(
      length & 0xff,
      (length >>> 8) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 24) & 0xff,
    );
  return encodeLength(key.length) + key + encodeLength(nodeId.length) + nodeId;
}

/**
 * Weighted Rendezvous score.
 *
 * Let h be the per-(key, node) hash mapped to (0, 1). The score is
 *
 *   score = ln(h) / weight
 *
 * and the node with the LARGEST score wins. This is the standard weighted
 * HRW formula: because ln(h)/w = ln(h^(1/w)), maximizing it is equivalent to
 * maximizing h^(1/w), under which node i wins with probability
 * w_i / sum_j w_j. (h itself is never exactly 0 or 1, so ln is finite.)
 *
 * Exact ties — only possible when two hashes coincide — are broken by the
 * lexicographically smaller node id (see `compareCandidates`).
 */
export function weightedScore(
  key: string,
  nodeId: string,
  weight: number,
  hash: Hash64 = fnv1a64,
): number {
  const hashValue = toUint64(hash(buildMessage(key, nodeId)));
  const h = unitInterval64(hashValue);
  return Math.log(h) / weight;
}

/** Score every eligible node for a key. Exposed mainly for testing. */
export function scoreAll(
  key: string,
  nodes: Iterable<Pick<NodeView, "id" | "weight">>,
  hash: Hash64 = fnv1a64,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const node of nodes) {
    scores.set(node.id, weightedScore(key, node.id, node.weight, hash));
  }
  return scores;
}

/**
 * Total order used for every selection decision:
 *   1. larger score wins;
 *   2. on an exact score tie, the lexicographically smaller id wins.
 *
 * Returns a negative number when `a` is BETTER than `b`.
 */
export function compareCandidates(
  a: { id: string; score: number },
  b: { id: string; score: number },
): number {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Validate a node descriptor, normalizing it for storage. */
export function normalizeNode(node: NodeInput): NodeView {
  if (typeof node.id !== "string" || node.id.length === 0) {
    throw new TypeError("Node id must be a non-empty string");
  }
  if (
    typeof node.weight !== "number" ||
    !Number.isFinite(node.weight) ||
    node.weight <= 0
  ) {
    throw new TypeError(`Node "${node.id}" weight must be a positive, finite number`);
  }
  if (
    node.domain !== undefined &&
    (typeof node.domain !== "string" || node.domain.length === 0)
  ) {
    throw new TypeError(`Node "${node.id}" domain must be a non-empty string when given`);
  }
  if (node.tags !== undefined && !Array.isArray(node.tags)) {
    throw new TypeError(`Node "${node.id}" tags must be an array of strings`);
  }
  return {
    id: node.id,
    weight: node.weight,
    ...(node.domain !== undefined ? { domain: node.domain } : {}),
    tags: [...(node.tags ?? [])],
  };
}
