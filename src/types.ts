/**
 * Core type definitions for weighted Rendezvous hashing (HRW).
 *
 * Each node is identified by a unique string id, carries a positive
 * floating point weight and may declare an optional failure-domain label
 * (plus arbitrary free-form tags). A node without a failure-domain label
 * is not constrained by the at-most-one-node-per-domain replica rule.
 */

/** Public, declarative description of a node accepted by the router. */
export interface NodeInput {
  /** Unique, non-empty node identifier. Deterministic across processes. */
  readonly id: string;
  /** Positive weight; larger weights are chosen proportionally more often. */
  readonly weight: number;
  /**
   * Failure-domain label. When selecting multiple replicas, at most one node
   * carrying a given label may appear in the result. Nodes without a label
   * each live in their own (unconstrained) domain.
   */
  readonly domain?: string | undefined;
  /** Optional free-form metadata; never participates in hashing. */
  readonly tags?: readonly string[] | undefined;
}

/** Snapshot view of a node stored by the router. */
export interface NodeView {
  readonly id: string;
  readonly weight: number;
  readonly domain?: string;
  readonly tags: readonly string[];
}

/**
 * Injectable 64-bit hash function.
 *
 * It must be deterministic across processes: for the same byte sequence it
 * always returns the same unsigned 64-bit value. The returned value may be a
 * native `number` (integers up to 2^53 are exact) or a `bigint`; the router
 * normalizes both.
 */
export type Hash64 = (message: string) => number | bigint;

/** A scored node, ordered by (higher score, then lexicographically smaller id). */
export interface ScoredNode {
  readonly id: string;
  readonly weight: number;
  readonly domain?: string;
  readonly tags: readonly string[];
  /** Score in the half-open interval [0, 1). Larger is better. */
  readonly score: number;
}
