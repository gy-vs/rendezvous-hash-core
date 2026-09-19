# rendezvous-hash-core

加权 Rendezvous 哈希（HRW, Highest Random Weight）纯库：把字符串 key 确定性地分配到一组可动态增删的节点上。无网络、无持久化、无 CLI、无页面、零运行时依赖。

- TypeScript + Node.js 20，ESM
- 不使用哈希环，也不依赖任何负载均衡库
- 分配按需从当前节点集合推导，不存在需要整体重洗的表

## 安装与构建

```bash
npm install
npm run build   # 产物在 dist/
npm test        # 编译并运行 node:test 测试套件
```

## 用法

```ts
import { RendezvousRouter } from 'rendezvous-hash-core';

const router = new RendezvousRouter([
  { id: 'node-a', weight: 1 },
  { id: 'node-b', weight: 4, labels: ['rack-2', 'zone-1'] },
  { id: 'node-c', weight: 2, labels: ['rack-3'] },
]);

router.select('user:123');
// { id: 'node-b', weight: 4, labels: ['rack-2', 'zone-1'] }

router.selectReplicas('user:123', 2);
// 至多 2 个节点，同一故障域标签内最多出现一个；候选不足时返回实际数量

router.selectBatch(['k1', 'k2']);
router.selectReplicasBatch(['k1', 'k2'], 3);

router.add({ id: 'node-d', weight: 1 });
router.remove('node-a');
```

## 打分公式

对每个 `(key, node)`：

1. 将 key 与 node id 做无歧义拼接（`<key 的 UTF-16 长度十进制>:<key><nodeId>`，长度前缀保证不同 `(key, id)` 不可能拼出同一字符串）；
2. 计算 64 位哈希；默认实现为 **FNV-1a 64 → SplitMix64 终化**，全部用 `bigint` 完成，跨进程/平台一致；
3. 取哈希低 52 位映射到开区间 `u ∈ (0, 1)`（`(v+1)/(2^52+2)`，两端点经 IEEE-754 舍入后仍严格位于区间内，保证 `-ln(u)` 有限且为正）；
4. 得分

   ```
   score = weight / -ln(u)
   ```

   得分最大的节点胜出。该加权 Rendezvous 变体下，任意 key 选中某节点的概率严格正比于其权重。

### 并列决胜

得分完全相同（IEEE-754 位级相等）时，按节点 id 的 **UTF-16 码元升序** 决胜，与插入顺序无关。

## 副本与故障域

`selectReplicas(key, k)` 按全局得分贪心：先取最优节点，剔除所有与其共享任一 `labels` 标签的存活节点，再在剩余候选中重复。无标签节点不与任何节点冲突。不同故障域不足时返回少于 `k` 的结果（可能为空数组）。

## 成员变更

节点集合中没有与 key 绑定的预置表。增删一个节点只影响该节点对某些 key 得分更高的那些 key；其余 key 的分配完全不变（测试中有针对增/删的精确校验）。重新加回相同节点集会恢复完全一致的分配。

## 复杂度

- 单节点：每个 key O(n) 次打分、O(1) 额外空间，不为节点列表排序。
- 无故障域的多副本：有界最小堆只保留前 k 个候选，O(n log k) 时间、O(k) 空间。
- 带故障域的多副本：每个节点每 key 只打一次分，随后 k 轮线性扫描，O(k·n) 次比较、O(n) 空间（k 通常为小常数）。
- 哈希对每个 `(key, node)` 只计算一次。

## 注入哈希函数（便于测试）

```ts
const router = new RendezvousRouter(nodes, {
  hash: (input: string) => my64BitHash(input), // 必须返回 0 <= h < 2^64 的 bigint
});
```

哈希要求：无符号 64 位 `bigint`，且对相同输入在任何进程、任何运行中结果一致（不得使用随机源）。返回值越界会抛出 `TypeError`。

## API

| 成员 | 说明 |
| --- | --- |
| `new RendezvousRouter(nodes?, options?)` | 可选初始节点与 `{ hash }` |
| `add(node)` / `remove(id)` / `has(id)` | 动态成员管理；同 id 再次 `add` 即替换 |
| `size` / `listNodes()` | 成员数量与防御性拷贝 |
| `select(key)` | 返回最优节点，空集合返回 `null` |
| `selectReplicas(key, k)` | 返回至多 `k` 个节点（得分降序），满足故障域互斥 |
| `selectBatch(keys)` / `selectReplicasBatch(keys, k)` | 批量接口，结果与输入对齐 |
| `scoreFor(key, nodeId)` | 查看某节点对某 key 的得分（introspection / 测试） |

节点形如 `{ id: string; weight: number（正数）; labels?: string[] }`。
