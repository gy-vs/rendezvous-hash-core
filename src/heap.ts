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
export class BoundedMinHeap<T> {
  private readonly heap: T[] = [];

  constructor(
    private readonly capacity: number,
    private readonly worse: (a: T, b: T) => boolean,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }
  }

  get size(): number {
    return this.heap.length;
  }

  offer(element: T): void {
    if (this.heap.length < this.capacity) {
      this.heap.push(element);
      this.siftUp(this.heap.length - 1);
    } else if (this.worse(this.heap[0] as T, element)) {
      this.heap[0] = element;
      this.siftDown(0);
    }
  }

  /** Remove and return all retained elements, best-ranked first. */
  drain(): T[] {
    const result: T[] = [];
    while (this.heap.length > 0) {
      result.push(this.extractRoot());
    }
    // Roots come out worst-first; the caller wants best-first.
    result.reverse();
    return result;
  }

  private extractRoot(): T {
    const root = this.heap[0] as T;
    const last = this.heap.pop() as T;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return root;
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      // The root is the worst retained element, so worse elements live
      // nearer the root. If the child is worse than its parent, swap up.
      if (this.worse(this.heap[current] as T, this.heap[parent] as T)) {
        this.swap(current, parent);
        current = parent;
      } else {
        return;
      }
    }
  }

  private siftDown(index: number): void {
    let current = index;
    const half = this.heap.length >> 1;
    while (current < half) {
      const left = 2 * current + 1;
      const right = left + 1;
      let preferredChild = left;
      if (
        right < this.heap.length &&
        // Sift toward the *worse* child: that is the slot a too-good
        // parent must exchange with to restore heap order.
        this.worse(this.heap[right] as T, this.heap[left] as T)
      ) {
        preferredChild = right;
      }
      // Order already holds when the parent is worse than (equal to) that
      // child; otherwise swap and keep sifting down.
      if (this.worse(this.heap[current] as T, this.heap[preferredChild] as T)) {
        return;
      }
      this.swap(current, preferredChild);
      current = preferredChild;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a] as T;
    this.heap[a] = this.heap[b] as T;
    this.heap[b] = tmp;
  }
}
