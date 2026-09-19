/**
 * Fixed-capacity binary min-heap storing only the best `capacity` elements
 * seen so far, according to a caller-supplied "better than" comparator.
 *
 * The heap root is the WORST retained element, so insertion is
 *   offer(x): if full and x is no better than the root, skip it in O(1);
 *             otherwise replace the root and sift down.
 *
 * Selecting the top k out of n therefore costs O(n log k) time and O(k)
 * memory, and crucially never sorts the whole node list.
 */
export class TopKHeap<T> {
  private readonly heap: T[] = [];

  constructor(
    private readonly capacity: number,
    /** Negative when `a` is better than `b`, like Array#sort comparators. */
    private readonly better: (a: T, b: T) => number,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError("TopKHeap capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.heap.length;
  }

  offer(value: T): void {
    if (this.heap.length < this.capacity) {
      this.heap.push(value);
      this.siftUp(this.heap.length - 1);
      return;
    }
    // Root is the worst kept element; replace it only with something better.
    if (this.better(value, this.heap[0] as T) < 0) {
      this.heap[0] = value;
      this.siftDown(0);
    }
  }

  /** Drain the heap, returning elements best-first. */
  drainBestFirst(): T[] {
    const result: T[] = [];
    while (this.heap.length > 0) {
      result.push(this.heap[0] as T);
      const last = this.heap.pop() as T;
      if (this.heap.length > 0) {
        this.heap[0] = last;
        this.siftDown(0);
      }
    }
    return result;
  }

  private siftUp(index: number): void {
    const value = this.heap[index] as T;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      // Min-heap on "better": the parent must not be better than the child,
      // i.e. value (child) bubbling up must be WORSE than the parent to stop.
      if (this.better(value, this.heap[parent] as T) >= 0) break;
      this.heap[index] = this.heap[parent] as T;
      index = parent;
    }
    this.heap[index] = value;
  }

  private siftDown(index: number): void {
    const value = this.heap[index] as T;
    const half = this.heap.length >> 1;
    while (index < half) {
      let child = (index << 1) + 1;
      const right = child + 1;
      if (
        right < this.heap.length &&
        this.better(this.heap[right] as T, this.heap[child] as T) < 0
      ) {
        child = right;
      }
      if (this.better(this.heap[child] as T, value) >= 0) break;
      this.heap[index] = this.heap[child] as T;
      index = child;
    }
    this.heap[index] = value;
  }
}
