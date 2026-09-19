import { fnv1a64 } from "./hash.js";
import { TopKHeap } from "./heap.js";
import { compareCandidates, normalizeNode, weightedScore } from "./score.js";
import type {
  Hash64,
  NodeInput,
  NodeView,
  ScoredNode,
} from "./types.js";

export interface RendezvousOptions {
  /**
   * 64-bit hash function used to derive per-(key, node) scores. Defaults to
   * an FNV-1a/SplitMix64 implementation; inject a custom one for
   * reproducible or adversarial test scenarios. It MUST be deterministic for
   * the same input across processes.
   */
  readonly hash?: Hash64 | undefined;
}

interface Candidate {
  readonly id: string;
  readonly score: number;
}

/**
 * Weighted Rendezvous (HRW) router.
 *
 * Each key is assigned to the node maximizing `ln(h(key, id)) / weight`,
 * where `h` is a 64-bit hash mapped to (0, 1); exact score ties are broken
 * by lexicographically smaller node id. Replica selection enforces
 * at-most-one node per failure-domain label. Results depend solely on the
 * (key, node) inputs, never on insertion order or process identity.
 *
 * Adding or removing a node only changes the keys whose winning candidate
 * was that node — there is no full-ring reshuffle, because HRW has no ring.
 */
export class RendezvousRouter {
  private readonly nodes = new Map<string, NodeView>();
  private readonly hash: Hash64;

  constructor(options: RendezvousOptions = {}) {
    if (options.hash !== undefined && typeof options.hash !== "function") {
      throw new TypeError("options.hash must be a function");
    }
    this.hash = options.hash ?? fnv1a64;
  }

  /** Number of currently registered nodes. */
  get size(): number {
    return this.nodes.size;
  }

  /** Add a node. Throws if the id is already registered. */
  addNode(node: NodeInput): this {
    const normalized = normalizeNode(node);
    if (this.nodes.has(normalized.id)) {
      throw new Error(`Node with id "${normalized.id}" already exists`);
    }
    this.nodes.set(normalized.id, normalized);
    return this;
  }

  /** Add several nodes at once. */
  addNodes(nodes: Iterable<NodeInput>): this {
    for (const node of nodes) this.addNode(node);
    return this;
  }

  /**
   * Remove a node by id. Returns true when a node was removed. Keys assigned
   * to that node deterministically migrate to the next-best remaining node;
   * every other key is unaffected.
   */
  removeNode(id: string): boolean {
    return this.nodes.delete(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): NodeView | undefined {
    return this.nodes.get(id);
  }

  /** Snapshot of all registered nodes (insertion order; not selection order). */
  nodes(): NodeView[] {
    return [...this.nodes.values()].map((node) => ({
      ...node,
      tags: [...node.tags],
    }));
  }

  nodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  /**
   * Select the single best node id for a key, or undefined when the router
   * is empty. O(n) time, O(1) extra space — a plain running-maximum scan;
   * the node list is never sorted.
   */
  pick(key: string): string | undefined {
    let best: Candidate | undefined;
    for (const node of this.nodes.values()) {
      const candidate: Candidate = {
        id: node.id,
        score: weightedScore(key, node.id, node.weight, this.hash),
      };
      if (best === undefined || compareCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }
    return best?.id;
  }

  /**
   * Select up to `replicas` distinct nodes for a key, best-first.
   *
   * At most one node per failure-domain label is returned; unlabeled nodes
   * are unconstrained. When fewer eligible nodes exist, the actual available
   * number is returned.
   *
   * O(n log k) time and O(k + d) space via a bounded top-k heap; nodes that
   * cannot make the current top k are discarded immediately, without sorting
   * the node list.
   */
  pickReplicas(key: string, replicas: number): string[] {
    if (!Number.isInteger(replicas) || replicas < 0) {
      throw new TypeError("replicas must be a non-negative integer");
    }
    if (replicas === 0 || this.nodes.size === 0) return [];

    const k = Math.min(replicas, this.nodes.size);
    const heap = new TopKHeap<Candidate>(k, compareCandidates);
    // Best representative seen so far per failure-domain label.
    const domainBest = new Map<string, Candidate>();

    for (const node of this.nodes.values()) {
      const candidate: Candidate = {
        id: node.id,
        score: weightedScore(key, node.id, node.weight, this.hash),
      };
      if (node.domain === undefined) {
        // Unlabeled nodes each live in their own domain; consider directly.
        heap.offer(candidate);
        continue;
      }
      const incumbent = domainBest.get(node.domain);
      if (incumbent === undefined) {
        domainBest.set(node.domain, candidate);
      } else if (compareCandidates(candidate, incumbent) < 0) {
        // A strictly better node for the same domain replaces the incumbent.
        domainBest.set(node.domain, candidate);
      }
    }

    for (const candidate of domainBest.values()) {
      heap.offer(candidate);
    }

    return heap.drainBestFirst().map((candidate) => candidate.id);
  }

  /**
   * Batch single-node selection. The result aligns positionally with the
   * input keys; empty entries are undefined.
   */
  pickMany(keys: Iterable<string>): (string | undefined)[] {
    const results: (string | undefined)[] = [];
    for (const key of keys) results.push(this.pick(key));
    return results;
  }

  /** Batch replica selection. The result aligns positionally with the keys. */
  pickReplicasMany(keys: Iterable<string>, replicas: number): string[][] {
    const results: string[][] = [];
    for (const key of keys) results.push(this.pickReplicas(key, replicas));
    return results;
  }

  /**
   * Diagnostic view: every node's score for a key in selection order (best
   * first, id tie-break). Not used by the hot selection paths.
   */
  scores(key: string): ScoredNode[] {
    const scored: ScoredNode[] = [];
    for (const node of this.nodes.values()) {
      scored.push({
        id: node.id,
        weight: node.weight,
        ...(node.domain !== undefined ? { domain: node.domain } : {}),
        tags: [...node.tags],
        score: weightedScore(key, node.id, node.weight, this.hash),
      });
    }
    return scored.sort(compareCandidates);
  }
}
