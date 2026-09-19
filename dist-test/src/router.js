import { BoundedMinHeap } from './heap.js';
import { defaultHash64, frameKeyAndNodeId, rendezvousScore, U64_WRAP, } from './hash.js';
/**
 * Weighted Rendezvous (Highest Random Weight) router.
 *
 * Pure, in-memory and stateless per key: assignments are derived on demand
 * from the current node set, so there is no global table to reshuffle when
 * members change. Adding or removing a node changes the answer for a key
 * only when that node outscores the previous choice(s) for that key — all
 * other keys keep their assignment.
 */
export class RendezvousRouter {
    nodes = new Map();
    hash;
    constructor(nodes = [], options = {}) {
        if (nodes === null || typeof nodes !== 'object' || typeof nodes[Symbol.iterator] !== 'function') {
            throw new TypeError('nodes must be an iterable of RendezvousNode objects');
        }
        if (options === null || typeof options !== 'object') {
            throw new TypeError('options must be an object');
        }
        const hash = options.hash ?? defaultHash64;
        if (typeof hash !== 'function') {
            throw new TypeError('options.hash must be a function');
        }
        this.hash = hash;
        for (const node of nodes) {
            this.add(node);
        }
    }
    get size() {
        return this.nodes.size;
    }
    /** Insert a node or replace the existing node with the same id. */
    add(node) {
        validateNode(node);
        // Deduplicate labels: a node carries a set of domain tags.
        const labels = node.labels === undefined ? [] : [...new Set(node.labels)];
        this.nodes.set(node.id, { id: node.id, weight: node.weight, labels });
        return this;
    }
    /** Remove a node by id. Returns true when something was removed. */
    remove(id) {
        return this.nodes.delete(id);
    }
    has(id) {
        return this.nodes.has(id);
    }
    /** Nodes in insertion (membership) order, as defensive copies. */
    listNodes() {
        return [...this.nodes.values()].map(toPublicNode);
    }
    /**
     * Score that `nodeId` attains for `key` (higher is better), or undefined
     * when no such node exists. Useful for introspection and for asserting the
     * scoring formula in tests.
     */
    scoreFor(key, nodeId) {
        if (typeof key !== 'string') {
            throw new TypeError('key must be a string');
        }
        const node = this.nodes.get(nodeId);
        if (node === undefined) {
            return undefined;
        }
        return rendezvousScore(this.hashKey(key, node.id), node.weight);
    }
    /**
     * Select the single best node for `key`, or null when the set is empty.
     *
     * Selection is by highest `weight / -ln(u)` score. Exactly equal scores
     * are broken by node id in ascending UTF-16 code-unit order, so the result
     * is independent of insertion order.
     */
    select(key) {
        if (typeof key !== 'string') {
            throw new TypeError('key must be a string');
        }
        let best = null;
        for (const node of this.nodes.values()) {
            const candidate = this.scoreCandidate(key, node);
            if (best === null || better(candidate, best)) {
                best = candidate;
            }
        }
        return best === null ? null : toPublicNode(best.node);
    }
    /**
     * Select up to `replicaCount` nodes for `key`, in descending score order.
     *
     * No two returned nodes share a failure-domain label; nodes without labels
     * never conflict. When not enough mutually-compatible candidates exist,
     * the returned array simply contains fewer entries than requested (it may
     * be empty).
     *
     * Selection is greedy by global score: the best node is chosen first, all
     * nodes colliding with it on any label are excluded, and the process
     * repeats among the survivors. This mirrors the standard HRW replica
     * rule. Scores for every node are computed exactly once per key.
     */
    selectReplicas(key, replicaCount) {
        if (typeof key !== 'string') {
            throw new TypeError('key must be a string');
        }
        if (!Number.isInteger(replicaCount) || replicaCount <= 0) {
            throw new TypeError('replicaCount must be a positive integer');
        }
        if (this.nodes.size === 0 || replicaCount === 1) {
            const single = this.select(key);
            return single === null ? [] : [single];
        }
        let anyLabeled = false;
        for (const node of this.nodes.values()) {
            if (node.labels.length > 0) {
                anyLabeled = true;
                break;
            }
        }
        if (!anyLabeled) {
            // Fast path: no failure domains. Keep only the best k candidates with
            // a bounded heap — no sort over the full node list, O(n log k).
            const heap = new BoundedMinHeap(Math.min(replicaCount, this.nodes.size), (a, b) => worse(a, b));
            for (const node of this.nodes.values()) {
                heap.offer(this.scoreCandidate(key, node));
            }
            return heap.drain().map((candidate) => toPublicNode(candidate.node));
        }
        // Label-aware path. Every score is computed exactly once. Each round
        // finds the best still-alive candidate by a linear scan (O(n)), and
        // marks every survivor colliding on one of its labels as dead. This
        // never sorts the node list; total work is O(k·n) comparisons with
        // O(n) storage, and replicas (k) are typically a small constant.
        const candidates = [];
        for (const node of this.nodes.values()) {
            candidates.push(this.scoreCandidate(key, node));
        }
        const alive = new Array(candidates.length).fill(true);
        const chosen = [];
        while (chosen.length < replicaCount) {
            let winnerIndex = -1;
            for (let i = 0; i < candidates.length; i++) {
                if (alive[i] && (winnerIndex === -1 || better(candidates[i], candidates[winnerIndex]))) {
                    winnerIndex = i;
                }
            }
            if (winnerIndex === -1) {
                break;
            }
            const winner = candidates[winnerIndex];
            chosen.push(toPublicNode(winner.node));
            alive[winnerIndex] = false;
            // Exclude survivors colliding on any of the winner's labels.
            // A winner without labels only excludes itself.
            if (winner.node.labels.length > 0) {
                const winnerLabels = new Set(winner.node.labels);
                for (let i = 0; i < candidates.length; i++) {
                    if (!alive[i]) {
                        continue;
                    }
                    const other = candidates[i];
                    if (other.node.labels.some((label) => winnerLabels.has(label))) {
                        alive[i] = false;
                    }
                }
            }
        }
        return chosen;
    }
    /** Batch form of {@link select}: one lookup per key, keys stay in order. */
    selectBatch(keys) {
        return keys.map((key) => this.select(key));
    }
    /** Batch form of {@link selectReplicas}: keys stay in order. */
    selectReplicasBatch(keys, replicaCount) {
        return keys.map((key) => this.selectReplicas(key, replicaCount));
    }
    scoreCandidate(key, node) {
        const hash = this.hashKey(key, node.id);
        return { node, hash, score: rendezvousScore(hash, node.weight) };
    }
    hashKey(key, nodeId) {
        const hash = this.hash(frameKeyAndNodeId(key, nodeId));
        if (typeof hash !== 'bigint' || hash < 0n || hash >= U64_WRAP) {
            throw new TypeError(`hash function must return an unsigned 64-bit bigint (0 <= h < 2^64); got ${String(hash)}`);
        }
        return hash;
    }
}
/**
 * Candidate ordering: better = higher score, ties broken by smaller id
 * (ascending UTF-16 code-unit order). A strict total order under the
 * documented rules (ids are unique).
 */
function better(a, b) {
    if (a.score !== b.score) {
        return a.score > b.score;
    }
    return a.node.id < b.node.id;
}
function worse(a, b) {
    return better(b, a);
}
function toPublicNode(node) {
    return { id: node.id, weight: node.weight, labels: [...node.labels] };
}
function validateNode(node) {
    if (node === null || typeof node !== 'object') {
        throw new TypeError('node must be an object with id, weight, and optional labels');
    }
    const candidate = node;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
        throw new TypeError('node.id must be a non-empty string');
    }
    if (typeof candidate.weight !== 'number' || !Number.isFinite(candidate.weight) || candidate.weight <= 0) {
        throw new TypeError(`node.weight must be a finite positive number (node ${JSON.stringify(candidate.id)})`);
    }
    if (candidate.labels !== undefined) {
        if (!Array.isArray(candidate.labels)) {
            throw new TypeError(`node.labels must be an array of strings (node ${JSON.stringify(candidate.id)})`);
        }
        for (const label of candidate.labels) {
            if (typeof label !== 'string' || label.length === 0) {
                throw new TypeError(`every label must be a non-empty string (node ${JSON.stringify(candidate.id)})`);
            }
        }
    }
}
//# sourceMappingURL=router.js.map