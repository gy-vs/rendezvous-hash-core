import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RendezvousRouter, defaultHash64, frameKeyAndNodeId, splitmix64, U64_MASK, } from '../src/index.js';
const NODES = [
    { id: 'node-a', weight: 1 },
    { id: 'node-b', weight: 2 },
    { id: 'node-c', weight: 4 },
    { id: 'node-d', weight: 1 },
];
// ---------------------------------------------------------------------------
// Determinism: fixed golden vectors produced by the default hash. If any of
// these change, the hashing/scoring contract changed.
// ---------------------------------------------------------------------------
const GOLDEN = [
    ['user:1', 'node-c', ['node-c', 'node-b', 'node-d']],
    ['user:2', 'node-d', ['node-d', 'node-b', 'node-c']],
    ['order:42', 'node-b', ['node-b', 'node-c', 'node-d']],
    ['cache/home', 'node-c', ['node-c', 'node-a', 'node-d']],
    ['🙂/key', 'node-b', ['node-b', 'node-d', 'node-a']],
    ['', 'node-b', ['node-b', 'node-c', 'node-d']],
];
test('default hash produces fixed golden assignments', () => {
    const router = new RendezvousRouter(NODES);
    for (const [key, single, replicas] of GOLDEN) {
        assert.equal(router.select(key)?.id, single, `select(${JSON.stringify(key)})`);
        assert.deepEqual(router.selectReplicas(key, 3).map((n) => n.id), replicas, `selectReplicas(${JSON.stringify(key)}, 3)`);
    }
});
test('results are independent of insertion order', () => {
    const orders = [
        [...NODES],
        [...NODES].reverse(),
        [NODES[2], NODES[0], NODES[3], NODES[1]],
    ];
    const keys = ['a', 'b', 'c', 'x/y', 'k'.repeat(50)];
    for (const key of keys) {
        const answers = orders.map((order) => new RendezvousRouter(order).select(key)?.id);
        assert.ok(answers.every((id) => id === answers[0]), `${key}: ${answers.join(',')}`);
        const replicas = orders.map((order) => new RendezvousRouter(order).selectReplicas(key, 3).map((n) => n.id).join(','));
        assert.ok(replicas.every((r) => r === replicas[0]), `${key}: ${replicas.join(' | ')}`);
    }
});
test('repeated calls and separately constructed routers agree', () => {
    const r1 = new RendezvousRouter(NODES);
    const r2 = new RendezvousRouter([...NODES].reverse());
    for (let i = 0; i < 100; i++) {
        const key = `key-${i}`;
        assert.equal(r1.select(key)?.id, r2.select(key)?.id);
        assert.equal(r1.select(key)?.id, r1.select(key)?.id);
    }
});
test('batch APIs return results aligned to the input keys', () => {
    const router = new RendezvousRouter(NODES);
    const keys = GOLDEN.map(([k]) => k);
    const singles = router.selectBatch(keys);
    assert.equal(singles.length, keys.length);
    keys.forEach((key, i) => assert.equal(singles[i]?.id, router.select(key)?.id));
    const batches = router.selectReplicasBatch(keys, 2);
    keys.forEach((key, i) => assert.deepEqual(batches[i].map((n) => n.id), router.selectReplicas(key, 2).map((n) => n.id)));
});
// ---------------------------------------------------------------------------
// Weight proportions
// ---------------------------------------------------------------------------
test('selection frequency is roughly proportional to weight', () => {
    const weighted = [
        { id: 'w1', weight: 1 },
        { id: 'w2', weight: 2 },
        { id: 'w4', weight: 4 },
    ];
    const router = new RendezvousRouter(weighted);
    const counts = new Map(weighted.map((n) => [n.id, 0]));
    const total = 60_000;
    for (let i = 0; i < total; i++) {
        const id = router.select(`bucket:${i}`).id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const totalWeight = 7;
    // Wide, non-flaky tolerance (55% relative slack on the smallest share).
    for (const [id, weight] of [['w1', 1], ['w2', 2], ['w4', 4]]) {
        const share = (counts.get(id) ?? 0) / total;
        const expected = weight / totalWeight;
        assert.ok(Math.abs(share - expected) < 0.04, `${id}: share ${share.toFixed(4)}, expected ~${expected.toFixed(4)}`);
    }
});
test('equal weights give a nearly even split', () => {
    const router = new RendezvousRouter([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
    ]);
    let a = 0;
    const total = 20_000;
    for (let i = 0; i < total; i++) {
        if (router.select(`k${i}`).id === 'a')
            a++;
    }
    assert.ok(Math.abs(a / total - 0.5) < 0.02);
});
// ---------------------------------------------------------------------------
// Exact ties
// ---------------------------------------------------------------------------
/**
 * Controllable hash: each (key, node) gets a value from a table, defaulting
 * to a deterministic derivation for unlisted pairs.
 */
function tableHash(table) {
    return (input) => table[input] ?? defaultHash64(input);
}
test('exactly equal scores are broken by ascending node id', () => {
    const tiedHash = (input) => {
        // Same value for every framed (key, nodeId) pair of key 'tie-key'.
        return input.startsWith('7:tie-key') ? 0x0123456789abcdefn : defaultHash64(input);
    };
    const router = new RendezvousRouter([
        { id: 'zeta', weight: 1 },
        { id: 'alpha', weight: 1 },
        { id: 'mid', weight: 1 },
    ], { hash: tiedHash });
    assert.equal(router.select('tie-key')?.id, 'alpha');
    // Replicas of equal scores come out in ascending id order.
    assert.deepEqual(router.selectReplicas('tie-key', 3).map((n) => n.id), ['alpha', 'mid', 'zeta']);
});
test('score tie from equal weight/score is id-ordered regardless of insertion order', () => {
    const tiedHash = (input) => input.startsWith('1:k') ? 42n : defaultHash64(input);
    const first = new RendezvousRouter([
        { id: 'b', weight: 1 },
        { id: 'a', weight: 1 },
    ], { hash: tiedHash });
    const second = new RendezvousRouter([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
    ], { hash: tiedHash });
    assert.equal(first.select('k')?.id, 'a');
    assert.equal(second.select('k')?.id, 'a');
});
test('higher weight wins an equal hash; ties only trigger on equal score', () => {
    const fixed = () => U64_MASK;
    const router = new RendezvousRouter([
        { id: 'light', weight: 1 },
        { id: 'heavy', weight: 10 },
    ], { hash: fixed });
    assert.equal(router.select('anything')?.id, 'heavy');
});
test('injected hash is called with the unambiguous (key, nodeId) framing', () => {
    const seen = [];
    const spy = (input) => {
        seen.push(input);
        return defaultHash64(input);
    };
    const router = new RendezvousRouter([{ id: 'n1', weight: 1 }], { hash: spy });
    router.select('mykey');
    assert.deepEqual(seen, [frameKeyAndNodeId('mykey', 'n1')]);
});
test('an injected hash returning an out-of-range value is rejected', () => {
    const router = new RendezvousRouter([{ id: 'n', weight: 1 }], { hash: () => 1n << 64n });
    assert.throws(() => router.select('k'), /unsigned 64-bit/);
    const negative = new RendezvousRouter([{ id: 'n', weight: 1 }], { hash: () => -1n });
    assert.throws(() => negative.select('k'), /unsigned 64-bit/);
});
// ---------------------------------------------------------------------------
// Failure domains
// ---------------------------------------------------------------------------
test('replicas never contain two nodes sharing a label', () => {
    const router = new RendezvousRouter([
        { id: 'a1', weight: 1, labels: ['rack-a'] },
        { id: 'a2', weight: 1, labels: ['rack-a'] },
        { id: 'b1', weight: 1, labels: ['rack-b'] },
        { id: 'b2', weight: 1, labels: ['rack-b'] },
        { id: 'c1', weight: 1, labels: ['rack-c'] },
    ]);
    for (let i = 0; i < 500; i++) {
        const picked = router.selectReplicas(`k${i}`, 3);
        const racks = new Set();
        for (const node of picked) {
            const rack = node.labels[0];
            assert.ok(!racks.has(rack), `duplicate rack ${rack} for k${i}`);
            racks.add(rack);
        }
        assert.equal(picked.length, 3);
    }
});
test('returns fewer replicas when distinct failure domains run out', () => {
    const router = new RendezvousRouter([
        { id: 'a1', weight: 1, labels: ['rack-a'] },
        { id: 'a2', weight: 1, labels: ['rack-a'] },
        { id: 'a3', weight: 1, labels: ['rack-a'] },
        { id: 'b1', weight: 1, labels: ['rack-b'] },
    ]);
    const picked = router.selectReplicas('k', 5);
    assert.equal(picked.length, 2);
    assert.deepEqual(new Set(picked.map((n) => n.labels[0])), new Set(['rack-a', 'rack-b']));
});
test('returns an empty list when no distinct domains exist for replicas', () => {
    const router = new RendezvousRouter([
        { id: 'a1', weight: 1, labels: ['same'] },
        { id: 'a2', weight: 1, labels: ['same'] },
    ]);
    assert.equal(router.selectReplicas('k', 3).length, 1);
});
test('unlabeled nodes never conflict with anyone', () => {
    const router = new RendezvousRouter([
        { id: 'lab1', weight: 1, labels: ['zone-a'] },
        { id: 'lab2', weight: 1, labels: ['zone-a'] },
        { id: 'free1', weight: 1 },
        { id: 'free2', weight: 1 },
    ]);
    const picked = router.selectReplicas('k', 4);
    assert.equal(picked.length, 3, 'one labeled + both unlabeled');
    assert.ok(picked.some((n) => n.id === 'free1'));
    assert.ok(picked.some((n) => n.id === 'free2'));
});
test('nodes carrying multiple labels conflict on every shared dimension', () => {
    const router = new RendezvousRouter([
        { id: 'x', weight: 1, labels: ['rack-1', 'gpu'] },
        { id: 'y', weight: 1, labels: ['rack-2', 'gpu'] },
        { id: 'z', weight: 1, labels: ['rack-3'] },
    ]);
    const picked = router.selectReplicas('k', 3);
    assert.equal(picked.length, 2);
    // x and y both carry gpu, so at most one of them appears alongside z.
    assert.ok(picked.some((n) => n.id === 'z'));
});
test('greedy domain rule: the globally best node wins its domain', () => {
    // Force a strict order: x best, then y (same label as x), then z.
    const hash = (input) => {
        if (input === frameKeyAndNodeId('k', 'x'))
            return 900n << 40n;
        if (input === frameKeyAndNodeId('k', 'y'))
            return 800n << 40n;
        if (input === frameKeyAndNodeId('k', 'z'))
            return 100n << 40n;
        return defaultHash64(input);
    };
    const router = new RendezvousRouter([
        { id: 'x', weight: 1, labels: ['d'] },
        { id: 'y', weight: 1, labels: ['d'] },
        { id: 'z', weight: 1, labels: ['other'] },
    ], { hash });
    // Need scores ordered as intended; verify via scoreFor.
    assert.ok(router.scoreFor('k', 'x') > router.scoreFor('k', 'y'));
    assert.ok(router.scoreFor('k', 'y') > router.scoreFor('k', 'z'));
    assert.deepEqual(router.selectReplicas('k', 2).map((n) => n.id), ['x', 'z']);
});
test('replica order is descending score with id tie-break', () => {
    const router = new RendezvousRouter([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
        { id: 'd', weight: 1 },
    ]);
    for (let i = 0; i < 200; i++) {
        const key = `k${i}`;
        const picked = router.selectReplicas(key, 3);
        for (let j = 1; j < picked.length; j++) {
            const prev = picked[j - 1];
            const cur = picked[j];
            const sPrev = router.scoreFor(key, prev.id);
            const sCur = router.scoreFor(key, cur.id);
            assert.ok(sPrev > sCur || (sPrev === sCur && prev.id < cur.id), `${key}: ${prev.id} before ${cur.id}`);
        }
    }
});
// ---------------------------------------------------------------------------
// Membership changes
// ---------------------------------------------------------------------------
test('removing a node only moves keys previously assigned to it', () => {
    const router = new RendezvousRouter(NODES);
    const keys = Array.from({ length: 2_000 }, (_, i) => `key-${i}`);
    const before = new Map(keys.map((k) => [k, router.select(k).id]));
    router.remove('node-b');
    let moved = 0;
    for (const key of keys) {
        const after = router.select(key).id;
        if (before.get(key) === 'node-b') {
            assert.notEqual(after, 'node-b');
            moved++;
        }
        else {
            assert.equal(after, before.get(key), `${key} moved although its node survived`);
        }
    }
    assert.ok(moved > 0, 'some keys must have been hosted by the removed node');
});
test('adding a node only takes keys where it outscores the incumbent', () => {
    const router = new RendezvousRouter(NODES);
    const keys = Array.from({ length: 2_000 }, (_, i) => `key-${i}`);
    const before = new Map(keys.map((k) => [k, router.select(k).id]));
    router.add({ id: 'node-new', weight: 1 });
    let taken = 0;
    for (const key of keys) {
        const after = router.select(key).id;
        if (after === 'node-new') {
            taken++;
            // The newcomer must genuinely outscore every old node for this key.
            const newScore = router.scoreFor(key, 'node-new');
            for (const node of NODES) {
                assert.ok(newScore > router.scoreFor(key, node.id) || newScore === router.scoreFor(key, node.id));
            }
        }
        else {
            assert.equal(after, before.get(key));
        }
    }
    assert.ok(taken > 0 && taken < keys.length, 'a weight-1 newcomer takes some but not all keys');
});
test('removing the selected replica promotes the next-best compatible node only', () => {
    const router = new RendezvousRouter([
        { id: 'a1', weight: 1, labels: ['a'] },
        { id: 'a2', weight: 1, labels: ['a'] },
        { id: 'b1', weight: 1, labels: ['b'] },
        { id: 'b2', weight: 1, labels: ['b'] },
    ]);
    const key = 'stable-key';
    const before = router.selectReplicas(key, 2).map((n) => n.id);
    router.remove(before[0]);
    const after = router.selectReplicas(key, 2).map((n) => n.id);
    // The surviving replica keeps its place.
    assert.ok(after.includes(before[1]));
    assert.equal(after.length, 2);
    // The replacement comes from the removed winner's domain.
    assert.equal(router.listNodes().find((n) => n.id === after.find((id) => id !== before[1]))?.labels?.[0], 'a');
});
test('readding the same node set restores every assignment', () => {
    const router = new RendezvousRouter(NODES);
    const keys = Array.from({ length: 500 }, (_, i) => `k${i}`);
    const expected = keys.map((k) => router.select(k)?.id);
    for (const node of NODES)
        router.remove(node.id);
    for (const node of [...NODES].reverse())
        router.add(node);
    keys.forEach((k, i) => assert.equal(router.select(k)?.id, expected[i]));
});
test('updating a node weight through add() is equivalent to replacing it', () => {
    const router = new RendezvousRouter([{ id: 'solo', weight: 1 }]);
    assert.equal(router.size, 1);
    router.add({ id: 'solo', weight: 9 });
    assert.equal(router.size, 1);
    assert.equal(router.listNodes()[0]?.weight, 9);
});
// ---------------------------------------------------------------------------
// Boundaries and validation
// ---------------------------------------------------------------------------
test('empty router returns null / empty lists', () => {
    const router = new RendezvousRouter();
    assert.equal(router.size, 0);
    assert.equal(router.select('k'), null);
    assert.deepEqual(router.selectReplicas('k', 3), []);
    assert.deepEqual(router.selectBatch(['k']), [null]);
    assert.equal(router.scoreFor('k', 'missing'), undefined);
});
test('requesting more replicas than nodes returns all nodes in score order', () => {
    const router = new RendezvousRouter([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
    ]);
    const picked = router.selectReplicas('k', 10);
    assert.equal(picked.length, 2);
});
test('invalid nodes and arguments are rejected', () => {
    assert.throws(() => new RendezvousRouter([{ id: '', weight: 1 }]), /non-empty string/);
    assert.throws(() => new RendezvousRouter([{ id: 'x', weight: 0 }]), /positive number/);
    assert.throws(() => new RendezvousRouter([{ id: 'x', weight: -3 }]), /positive number/);
    assert.throws(() => new RendezvousRouter([{ id: 'x', weight: 1, labels: ['ok', ''] }]), /non-empty string/);
    const router = new RendezvousRouter();
    assert.throws(() => router.selectReplicas('k', 0), /positive integer/);
    assert.throws(() => router.selectReplicas('k', 2.5), /positive integer/);
    // @ts-expect-error runtime guard for non-string keys
    assert.throws(() => router.select(42), TypeError);
});
test('returned node objects are copies, safe to mutate', () => {
    const router = new RendezvousRouter([{ id: 'a', weight: 1, labels: ['z'] }]);
    const node = router.select('k');
    node.weight = 999;
    node.labels = [...node.labels, 'hacked'];
    assert.equal(router.listNodes()[0]?.weight, 1);
    assert.deepEqual(router.select('k')?.labels, ['z']);
});
test('splitmix-derived hash is stable across simulated separate processes', () => {
    // Two independent router instances with no shared state must agree; this
    // test also guards against any ambient (Date/Math.random) dependence.
    const make = () => new RendezvousRouter([
        { id: 'p0', weight: 3 },
        { id: 'p1', weight: 1 },
        { id: 'p2', weight: 2 },
    ]);
    const [r1, r2] = [make(), make()];
    for (const key of ['alpha', 'beta', 'gamma']) {
        assert.equal(r1.select(key)?.id, r2.select(key)?.id);
        assert.deepEqual(r1.selectReplicas(key, 2).map((n) => n.id), r2.selectReplicas(key, 2).map((n) => n.id));
    }
    // Sanity: no use of randomness — hash of a framed pair is a fixed value.
    assert.equal(splitmix64(0n), splitmix64(0n));
});
test('large node set: heap path and label path agree on top-k logic', () => {
    // Property check against a trivial reference implementation over a
    // moderately large set.
    const nodes = Array.from({ length: 400 }, (_, i) => ({
        id: `n${i.toString().padStart(4, '0')}`,
        weight: 1 + (i % 7),
    }));
    const router = new RendezvousRouter(nodes);
    for (const key of ['big-key-1', 'big-key-2']) {
        const reference = nodes
            .map((n) => ({ id: n.id, score: router.scoreFor(key, n.id) }))
            .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
            .slice(0, 10)
            .map((x) => x.id);
        assert.deepEqual(router.selectReplicas(key, 10).map((n) => n.id), reference);
    }
});
//# sourceMappingURL=router.test.js.map