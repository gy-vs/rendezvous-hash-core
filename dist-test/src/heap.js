/**
 * A bounded binary min-heap that retains only the `capacity` highest-ranked
 * elements ever offered to it.
 *
 * Ranking is defined by the caller-supplied comparator: `worse(a, b)` is
 * true when `a` is *worse* (more evictable) than `b`. The heap root is
 * always the worst retained element, so the insertion rule is:
 *
 *   - while size < capacity: insert unconditionally;
 *   - once full: keep the candidate only if it beats the root, replacing it.
 *
 * Cost per key over `n` nodes is O(n log k) with O(k) storage, instead of
 * sorting every node (O(n log n) and O(n) storage). When k === 1 the heap
 * degenerates to a single-slot comparison.
 *
 * `drain()` returns the retained elements sorted best-first.
 */
export class BoundedMinHeap {
    capacity;
    worse;
    heap = [];
    constructor(capacity, worse) {
        this.capacity = capacity;
        this.worse = worse;
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new TypeError('capacity must be a positive integer');
        }
    }
    get size() {
        return this.heap.length;
    }
    offer(element) {
        if (this.heap.length < this.capacity) {
            this.heap.push(element);
            this.siftUp(this.heap.length - 1);
        }
        else if (this.worse(this.heap[0], element)) {
            this.heap[0] = element;
            this.siftDown(0);
        }
    }
    /** Remove and return all retained elements, best-ranked first. */
    drain() {
        const result = [];
        while (this.heap.length > 0) {
            result.push(this.extractRoot());
        }
        // Roots come out worst-first; the caller wants best-first.
        result.reverse();
        return result;
    }
    extractRoot() {
        const root = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.siftDown(0);
        }
        return root;
    }
    siftUp(index) {
        let current = index;
        while (current > 0) {
            const parent = (current - 1) >> 1;
            // The root is the worst retained element, so worse elements live
            // nearer the root. If the child is worse than its parent, swap up.
            if (this.worse(this.heap[current], this.heap[parent])) {
                this.swap(current, parent);
                current = parent;
            }
            else {
                return;
            }
        }
    }
    siftDown(index) {
        let current = index;
        const half = this.heap.length >> 1;
        while (current < half) {
            const left = 2 * current + 1;
            const right = left + 1;
            let preferredChild = left;
            if (right < this.heap.length &&
                // Sift toward the *worse* child: that is the slot a too-good
                // parent must exchange with to restore heap order.
                this.worse(this.heap[right], this.heap[left])) {
                preferredChild = right;
            }
            // Order already holds when the parent is worse than (equal to) that
            // child; otherwise swap and keep sifting down.
            if (this.worse(this.heap[current], this.heap[preferredChild])) {
                return;
            }
            this.swap(current, preferredChild);
            current = preferredChild;
        }
    }
    swap(a, b) {
        const tmp = this.heap[a];
        this.heap[a] = this.heap[b];
        this.heap[b] = tmp;
    }
}
//# sourceMappingURL=heap.js.map