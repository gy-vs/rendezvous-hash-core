import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareCandidates,
  fnv1a64,
  RendezvousRouter,
  weightedScore,
  type Hash64,
} from "../index.js";

/**
 * Chi-square-ish proportion check: with weights w_i the HRW winner
 * distribution converges to w_i / sum(w). We use a generous tolerance that
 * holds with enormous margin at this sample size while still catching a
 * totally broken implementation (e.g. uniform selection).
 */
function winnerCounts(
  router: RendezvousRouter,
  count: number,
  prefix = "key",
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const winner = router.pick(`${prefix}:${i}`);
    counts.set(winner!, (counts.get(winner!) ?? 0) + 1);
  }
  return counts;
}

test("selection frequency matches weight proportions", () => {
  const weights = [
    { id: "w1", weight: 1 },
    { id: "w2", weight: 2 },
    { id: "w3", weight: 3 },
  ];
  const total = 6;
  const router = new RendezvousRouter().addNodes(weights);
  const N = 20_000;
  const counts = winnerCounts(router, N);

  for (const node of weights) {
    const observed = counts.get(node.id)! / N;
    const expected = node.weight / total;
    assert.ok(
      Math.abs(observed - expected) < 0.03,
      `${node.id}: observed ${observed.toFixed(4)}, expected ~${expected.toFixed(4)}`,
    );
  }

  // Relative ordering must hold with near certainty: w3 > w2 > w1.
  assert.ok(counts.get("w3")! > counts.get("w2")!);
  assert.ok(counts.get("w2")! > counts.get("w1")!);
});

test("equal weights split traffic approximately evenly", () => {
  const router = new RendezvousRouter()
    .addNode({ id: "a", weight: 1 })
    .addNode({ id: "b", weight: 1 })
    .addNode({ id: "c", weight: 1 })
    .addNode({ id: "d", weight: 1 });
  const N = 20_000;
  const counts = winnerCounts(router, N);
  for (const id of ["a", "b", "c", "d"]) {
    const observed = counts.get(id)! / N;
    assert.ok(Math.abs(observed - 0.25) < 0.025, `${id}: ${observed}`);
  }
});

test("fractional weights are honored (1 vs 4 is 20/80)", () => {
  const router = new RendezvousRouter()
    .addNode({ id: "light", weight: 0.5 })
    .addNode({ id: "heavy", weight: 2.0 });
  const N = 20_000;
  const counts = winnerCounts(router, N);
  const heavyShare = counts.get("heavy")! / N;
  assert.ok(Math.abs(heavyShare - 0.8) < 0.03, `heavy share ${heavyShare}`);
});

test("weight changes shift future picks but never crash invariants", () => {
  // Rebuilding with a changed weight must give a smooth (partial) migration:
  // heavier node's share grows.
  const light = new RendezvousRouter()
    .addNode({ id: "a", weight: 1 })
    .addNode({ id: "b", weight: 1 });
  const heavy = new RendezvousRouter()
    .addNode({ id: "a", weight: 1 })
    .addNode({ id: "b", weight: 9 });
  const N = 10_000;
  const lightShareB = winnerCounts(light, N).get("b")! / N;
  const heavyShareB = winnerCounts(heavy, N).get("b")! / N;
  assert.ok(Math.abs(lightShareB - 0.5) < 0.03);
  assert.ok(Math.abs(heavyShareB - 0.9) < 0.03);
  assert.ok(heavyShareB > lightShareB + 0.3);
});

test("score formula matches ln(h)/w documented definition", () => {
  // h = 2^-32 (~2.33e-10) injected directly as a 64-bit value.
  const h64 = 1n << 32n; // unitInterval64 -> 2^-32
  const hash: Hash64 = () => h64;
  const router = new RendezvousRouter({ hash }).addNode({ id: "x", weight: 2 });
  const h = 2 ** -32;
  const expected = Math.log(h) / 2;
  assert.equal(router.scores("k")[0]!.score, expected);
  assert.equal(weightedScore("k", "x", 2, hash), expected);
});

test("exact score ties are broken by lexicographically smaller id", () => {
  const hash: Hash64 = () => 0x4242424242424242n;
  const router = new RendezvousRouter({ hash })
    .addNode({ id: "zeta", weight: 1 })
    .addNode({ id: "alpha", weight: 1 })
    .addNode({ id: "mid", weight: 1 });
  assert.equal(router.pick("any-key"), "alpha");
  assert.deepEqual(router.pickReplicas("any-key", 5), ["alpha", "mid", "zeta"]);

  const scores = router.scores("any-key");
  assert.ok(scores[0]!.score === scores[1]!.score);
  assert.ok(compareCandidates(scores[0]!, scores[1]!) < 0);
});

test("weight outranks id; id only decides exact score ties", () => {
  const hash: Hash64 = () => 0x123456789abcdefn;
  const router = new RendezvousRouter({ hash })
    .addNode({ id: "aaaa", weight: 1 })
    .addNode({ id: "zzzz", weight: 5 });
  // Larger weight makes ln(h)/w less negative -> zzzz wins despite its id.
  assert.equal(router.pick("k"), "zzzz");
});

test("default hash does not collide across realistic keys (scores distinct)", () => {
  const router = new RendezvousRouter()
    .addNodes(
      Array.from({ length: 50 }, (_, i) => ({ id: `node-${i}`, weight: 1 + (i % 5) })),
    );
  for (let i = 0; i < 500; i++) {
    const scores = router.scores(`bucket/key/${i}`).map((s) => s.score);
    assert.equal(new Set(scores).size, scores.length);
  }
});

test("injected hash accepts numbers, including signed 32-bit style output", () => {
  const hash: Hash64 = (message: string) =>
    Number((fnv1a64(message) & 0xffffffffn) | 0n);
  const router = new RendezvousRouter({ hash })
    .addNode({ id: "a", weight: 1 })
    .addNode({ id: "b", weight: 1 });
  for (let i = 0; i < 200; i++) {
    const winner = router.pick(`k${i}`);
    assert.ok(winner === "a" || winner === "b");
  }
});
