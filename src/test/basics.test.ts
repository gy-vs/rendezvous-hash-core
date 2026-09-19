import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  fnv1a64,
  RendezvousRouter,
  type Hash64,
  type NodeInput,
} from "../index.js";

const NODES: NodeInput[] = [
  { id: "node-a", weight: 1 },
  { id: "node-b", weight: 2 },
  { id: "node-c", weight: 3 },
  { id: "node-d", weight: 1.5, domain: "rack-1" },
  { id: "node-e", weight: 2.5, domain: "rack-2" },
  { id: "node-f", weight: 4 },
];

function shuffled<T>(values: readonly T[], seed: number): T[] {
  // Deterministic LCG shuffle so this test is itself reproducible.
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const KEYS = Array.from({ length: 500 }, (_, i) => `tenant/42/key/${i}`);

test("empty router picks nothing", () => {
  const router = new RendezvousRouter();
  assert.equal(router.size, 0);
  assert.equal(router.pick("anything"), undefined);
  assert.deepEqual(router.pickReplicas("anything", 3), []);
  assert.deepEqual(router.pickMany(["a", "b"]), [undefined, undefined]);
  assert.deepEqual(router.pickReplicasMany(["a", "b"], 3), [[], []]);
});

test("single node receives every key", () => {
  const router = new RendezvousRouter().addNode({ id: "solo", weight: 0.25 });
  for (const key of KEYS.slice(0, 50)) {
    assert.equal(router.pick(key), "solo");
    assert.deepEqual(router.pickReplicas(key, 3), ["solo"]);
  }
});

test("pick always returns a registered node", () => {
  const router = new RendezvousRouter().addNodes(NODES);
  const ids = new Set(NODES.map((node) => node.id));
  for (const key of KEYS) {
    assert.ok(ids.has(router.pick(key)!), `pick for ${key} not a member`);
  }
});

test("result is independent of node insertion order", () => {
  const baseline = new RendezvousRouter().addNodes(NODES);
  for (let seed = 1; seed <= 8; seed++) {
    const reordered = new RendezvousRouter().addNodes(shuffled(NODES, seed));
    for (const key of KEYS) {
      assert.equal(reordered.pick(key), baseline.pick(key), `key=${key} seed=${seed}`);
      assert.deepEqual(
        reordered.pickReplicas(key, 3),
        baseline.pickReplicas(key, 3),
        `replicas key=${key} seed=${seed}`,
      );
    }
  }
});

test("results are stable across batches and repeated calls", () => {
  const router = new RendezvousRouter().addNodes(NODES);
  const singles = KEYS.map((key) => router.pick(key));
  const batched = router.pickMany(KEYS);
  assert.deepEqual(batched, singles);
  assert.deepEqual(KEYS.map((key) => router.pick(key)), singles);
});

test("default hash is a stable unsigned 64-bit value", () => {
  const expected = fnv1a64("hello");
  assert.equal(typeof expected, "bigint");
  assert.ok(expected >= 0n && expected <= 0xffffffffffffffffn);
  assert.equal(fnv1a64("hello"), expected);
  assert.notEqual(fnv1a64("hello"), fnv1a64("hellp"));
});

test("deterministic across OS processes (fresh child process)", () => {
  const router = new RendezvousRouter().addNodes(NODES);
  const parent = router.pickReplicasMany(KEYS, 3);

  const childScript = `
    import { RendezvousRouter } from ${JSON.stringify(fileURLToPath(new URL("../index.js", import.meta.url)))};
    const NODES = ${JSON.stringify(NODES)};
    const KEYS = ${JSON.stringify(KEYS)};
    const router = new RendezvousRouter().addNodes(NODES);
    process.stdout.write(JSON.stringify(router.pickReplicasMany(KEYS, 3)));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), parent);
});

test("custom injected hash is used for scoring", () => {
  // Wrapping the default hash must not change results.
  const hash: Hash64 = (message: string): bigint => fnv1a64(message);
  const a = new RendezvousRouter({ hash }).addNodes(NODES);
  const b = new RendezvousRouter().addNodes(NODES);
  assert.deepEqual(b.pickMany(KEYS), a.pickMany(KEYS));

  // Equal weight + constant hash produces an exact tie -> smallest id wins,
  // regardless of insertion order.
  const constant: Hash64 = () => 1n;
  const equalWeight = new RendezvousRouter({ hash: constant })
    .addNode({ id: "z", weight: 1 })
    .addNode({ id: "a", weight: 1 })
    .addNode({ id: "m", weight: 1 });
  assert.equal(equalWeight.pick("k"), "a");
  assert.deepEqual(equalWeight.pickReplicas("k", 3), ["a", "m", "z"]);
});
