import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fnv1a64,
  frameKeyAndNodeId,
  rendezvousScore,
  splitmix64,
  uniform01,
  U64_MASK,
} from '../src/hash.js';
import { BoundedMinHeap } from '../src/heap.js';

test('fnv1a64 matches the published FNV-1a 64-bit test vector', () => {
  // http://www.isthe.com/chongo/tech/comp/fnv/index.html
  assert.equal(fnv1a64(''), 0xcbf29ce484222325n);
  assert.equal(fnv1a64('a'), 0xaf63dc4c8601ec8cn);
  assert.equal(fnv1a64('foobar'), 0x85944171f73967e8n);
});

test('fnv1a64 hashes UTF-8 bytes, not UTF-16 code units', () => {
  // "é" as U+00E9 (2 UTF-8 bytes) vs U+0065 U+0301 (3 UTF-8 bytes) differ.
  const precomposed = '\u00e9'; // e-acute as one code point
  const decomposed = 'e\u0301'; // 'e' + combining acute accent
  assert.equal(precomposed.length, 1);
  assert.equal(decomposed.length, 2);
  assert.notEqual(fnv1a64(precomposed), fnv1a64(decomposed));
  for (const value of [precomposed, '日本語', '🙂', '\0', 'a\0b']) {
    const h = fnv1a64(value);
    assert.ok(h >= 0n && h <= U64_MASK);
  }
});

test('splitmix64 stays within 64 bits and is deterministic', () => {
  assert.equal(splitmix64(0n), splitmix64(0n));
  assert.notEqual(splitmix64(0n), splitmix64(1n));
  for (const seed of [0n, 1n, U64_MASK, 1n << 100n]) {
    const out = splitmix64(seed);
    assert.ok(out >= 0n && out <= U64_MASK);
  }
});

test('frameKeyAndNodeId is injective for distinct (key, id) pairs', () => {
  // A length-prefix means moving the boundary cannot collide.
  assert.notEqual(frameKeyAndNodeId('ab', 'c'), frameKeyAndNodeId('a', 'bc'));
  // Content resembling the separator cannot blur the boundary either.
  assert.notEqual(frameKeyAndNodeId('1:x', 'y'), frameKeyAndNodeId('1', ':xy'));
  assert.notEqual(frameKeyAndNodeId('a:b', 'c'), frameKeyAndNodeId('a', ':bc'));
});

test('uniform01 always lands strictly inside (0, 1)', () => {
  for (const h of [0n, U64_MASK, 1n, 1n << 52n]) {
    const u = uniform01(h);
    assert.ok(u > 0 && u < 1, `u=${u} for hash=${h}`);
  }
});

test('rendezvousScore: same hash gives scores proportional to weight', () => {
  const hash = 0xdeadbeefcafef00dn;
  const s1 = rendezvousScore(hash, 1);
  const s4 = rendezvousScore(hash, 4);
  assert.ok(Math.abs(s4 / s1 - 4) < 1e-12);
  assert.throws(() => rendezvousScore(hash, 0), TypeError);
  assert.throws(() => rendezvousScore(hash, -1), TypeError);
  assert.throws(() => rendezvousScore(hash, Number.POSITIVE_INFINITY), TypeError);
});

test('BoundedMinHeap keeps only the k highest-ranked elements, best-first', () => {
  // Rank by .v ascending; capacity 3.
  const heap = new BoundedMinHeap<{ v: number }>(3, (a, b) => a.v < b.v);
  for (const v of [5, 1, 9, 3, 7, 2, 8]) {
    heap.offer({ v });
  }
  assert.deepEqual(heap.drain().map((x) => x.v), [9, 8, 7]);
});

test('BoundedMinHeap handles fewer offers than capacity and capacity 1', () => {
  const heap = new BoundedMinHeap<number>(5, (a, b) => a < b);
  [3, 1, 2].forEach((v) => heap.offer(v));
  assert.deepEqual(heap.drain(), [3, 2, 1]);

  const one = new BoundedMinHeap<number>(1, (a, b) => a < b);
  for (const v of [3, 1, 2, 9, 0]) {
    one.offer(v);
  }
  assert.deepEqual(one.drain(), [9]);
});

test('BoundedMinHeap comparator drives eviction (custom worst ordering)', () => {
  // Retain the *shortest* strings: worse = longer.
  const heap = new BoundedMinHeap<string>(2, (a, b) => a.length > b.length);
  ['aaaa', 'b', 'ccc', 'dd', 'eeeeee'].forEach((s) => heap.offer(s));
  assert.deepEqual(heap.drain(), ['b', 'dd']);
});
