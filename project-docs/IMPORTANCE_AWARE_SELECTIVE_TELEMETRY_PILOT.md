# 重要性感知选择性 LEO-INT：实现与短试验报告

## 1. 研究问题

本次改动验证如下想法：利用过去若干时间片的 Ground OAM 观测识别重要节点和链路，规划能够到达这些对象的 probe 路径；路径上的卫星仍负责转发，但只有必要对象写入对应 INT metadata。

目标不是单纯减少探测路径，而是在严格因果和非全知条件下同时满足：

- 实际遥测总字节下降；
- 全局 CPU、队列、电量和链路利用率 MAE 基本不退化；
- 关键对象误差下降；
- 有真实正样本的异常召回率提高或至少不退化；
- 全网最大状态年龄（AoI）不超过配置上限；
- 第一阶段真值只在运行结束后用于评估。

## 2. 因果重要性模型

在时间片 `t` 规划时，只允许使用 `source_slice_index < t` 的 Ground OAM、已知业务路由和可预测轨道接触状态。对象 `o` 的重要性为：

\[
I_o(t)=\sum_k \bar w_k s_{o,k}(t),
\qquad
\bar w_k=\frac{w_k}{\sum_j w_j}
\]

当前原始权重为：不确定性 0.30、AoI 0.22、历史波动 0.18、业务影响 0.12、可预测拓扑风险 0.12、公平性 0.06、状态临界度 0.18。归一化后再参与加权。

节点临界度使用上一片可观测状态：

\[
C_i^V(t)=\max\left(
\frac{CPU_i}{100},
\frac{Queue_i}{100},
\frac{QueuedTraffic_i}{1024},
RiskMode_i
\right)
\]

链路临界度为：

\[
C_e^E(t)=\max\left(
\frac{Util_e}{100},
\frac{Congestion_e}{100},
\frac{QueueLatency_e}{200},
DownRisk_e
\right)
\]

这些值来自滞后 OAM 估计，不读取当前时间片隐藏真值。当前代码会拒绝所有 `source_slice_index >= target_slice_index` 的反馈。

## 3. 基础路径与有界增量修复

候选方案不替换原增强 INT-MC 已完成的基础路径集合，而是在基础选择结束后追加修复路径：

\[
P_t=P_t^{base}\cup P_t^{repair}
\]

增量路径只有满足以下任一强证据时才有资格加入：

- Ground OAM 强制目标；
- 已产生正 AoI 债务；
- 滞后状态临界度超过门限。

普通、低临界度的提前刷新不会消耗增量 probe。路径单位开销收益综合目标重要性、AoI 债务、临界度和实际 metadata 成本，并在每片独立的字节储备内贪心选择。

若当前最老对象数为 `N_old`，任意单条候选路径最多覆盖 `K_max` 个最老对象，则清除该债务至少需要：

\[
L_{min}=\left\lceil\frac{N_{old}}{K_{max}}\right\rceil
\]

实现会把该下界用于修复路径候选上限，但最终追加数量仍受强证据和 15% 修复字节储备约束，因而不会无界扩张。

## 4. 逐跳选择性 metadata

当前字段档位如下：

| 档位 | 字节 | 含义 |
|---|---:|---|
| `node-full` | 96 B | 目标节点完整运行状态 |
| `node-core` | 32 B | CPU、队列、电量、模式等核心状态，不重复携带可由路径确定的节点 ID |
| `link-core` / `link-full` | 48 B | 链路状态、利用率、时延、容量、拥塞、队列、丢弃和 PER |
| `link-light` | 20 B | 链路 ID、up/down、利用率和队列时延 |
| `forward-only` | 0 B | 只转发 probe，不形成 OAM 状态记录 |

基础路径继续使用保守核心字段。数量受限的修复路径采用 `node-core + link-core`，避免 96 B 全量节点状态，同时保留异常检测所需指标。重复观测或纯中继跳可以使用 `forward-only`。

链路 ID 内含 `->`。实现已修复路径解析器，只把两侧带空格的 ` > ` 识别为列表分隔符，避免把 `intra-plane:P01-S01->P01-S02` 错拆为两个 ID。

## 5. 目标邻域链路采集

probe 不必为了读取链路状态而强制沿该链路转发。若路径经过目标链路任一端点，卫星可以读取本地端口状态，并只写入被点名链路的 `link-core` metadata：

\[
e=(u,v),\quad u\in P\ \lor\ v\in P
\Rightarrow e\in\Omega_t^{local}
\]

该模式在产物中标记为 `target-neighborhood`。它不会扫描同一节点的所有相邻链路；runner 只生成 `importance_adjacent_link_target_ids` 指定的本地链路记录，每条记录的 48 B 会进入报告和总字节统计。

## 6. 开销口径

修复候选的保守生成字节估计为：

\[
B(P)=B_{probe}+B_{report}+B_{mask}
+2\left(B_{path\ metadata}+B_{adjacent\ targets}\right)
\]

其中 `B_probe=64 B`、`B_report=128 B`；系数 2 表示 metadata 随 probe 到达 sink 后还进入回传报告。最终结论使用 runner 输出的实际总字节，而不是只使用该规划估计。实际总量包含 metadata、目标 mask、probe 基础头、报告及既有流水线定义的转发开销。

## 7. 短试验结果

### 7.1 64 节点高负载异常场景，24 时间片

产物：`reports/_scratch/importance-aware-telemetry-pilot-anomaly-base-plus-repair-v7/`

| 指标 | 当前增强基线 | 重要性路径 + 选择性写入 | 变化 |
|---|---:|---:|---:|
| 总遥测字节 | 961188.864 | 799520 | -16.82% |
| 字节/节点/片 | 625.7740 | 520.5208 | -16.82% |
| CPU MAE | 2.0496 | 1.3420 | 下降 |
| 队列 MAE | 2.5882 | 1.9086 | 下降 |
| 电量 MAE | 0.2804 | 0.1860 | 下降 |
| 链路利用率 MAE | 0.4714 | 0.3000 | 下降 |
| 关键 CPU MAE | 1.9476 | 1.6935 | 下降 |
| 关键链路利用率 MAE | 0.3984 | 0.0000 | 下降 |
| CPU 异常召回 | 0.9385 | 0.9692 | +0.0307 |
| 利用率异常召回 | 1.0000 | 1.0000 | 持平 |
| 拥塞异常召回 | 1.0000 | 1.0000 | 持平 |
| 异常宏召回 | 0.9795 | 0.9897 | +0.0102 |
| 最大 AoI | 6 | 3 | 改善 |

该场景通过基础门禁和“主目标”门禁，因果反馈违规数为 0。

### 7.2 Telesat 27x13 中型场景，12 时间片

产物：`reports/_scratch/importance-aware-telemetry-pilot-telesat-base-plus-repair-v9/`

| 指标 | 当前增强基线 | 重要性路径 + 选择性写入 | 变化 |
|---|---:|---:|---:|
| 总遥测字节 | 1683118.080 | 1524624 | -9.42% |
| 字节/节点/片 | 399.6007 | 361.9715 | -9.42% |
| CPU MAE | 1.0834 | 0.7331 | 下降 |
| 队列 MAE | 0.0730 | 0.0419 | 下降 |
| 电量 MAE | 0.7843 | 0.5978 | 下降 |
| 链路利用率 MAE | 0.4289 | 0.2912 | 下降 |
| 关键 CPU MAE | 1.4980 | 0.9440 | 下降 |
| 关键链路利用率 MAE | 0.6364 | 0.5416 | 下降 |
| 最大 AoI | 11 | 6 | 达到上限 |
| 目标最大 AoI | 11 | 5 | 改善 |
| AoI 超龄比例 | 0.00147 | 0 | 清零 |

该场景没有足够的 CPU/利用率/拥塞异常正样本，因此只能通过基础门禁，不能声称已证明异常召回提升。因果反馈违规数为 0。

## 8. 已证明与未证明的边界

当前短试验支持：

- 在两个固定短场景中，实际遥测字节下降且全局重构误差没有退化；
- 关键状态误差下降；
- 在异常正样本充足的高负载场景中，CPU 异常召回提高；
- 中型场景最大 AoI 被压到配置上限；
- 规划输入保持严格时间因果，产物审计通过。

当前尚不能声称：

- 48 时间片、多个随机种子和三种正式星座上均获得同样幅度；
- 所有异常类型都一定提高；
- 结果等同真实运营商在轨 INT 或 P4/Tofino 逐包性能；
- 该短试验可以替代实验 2 的正式统计检验。

中大型星座的单次 48 时间片确定性回放已经完成，但正式论文证据仍需运行多种子，并报告均值、标准差、置信区间、Pareto 前沿和机制消融。

## 9. 关键代码与验证

- 因果目标、字段 mask、有界修复：`stage2-int/tools/importance-aware-telemetry.mjs`
- 路径规划集成：`stage2-int/tools/int-mc-path-selector.mjs`
- 逐跳执行和目标邻域采集：`stage2-int/tools/probe-int-runner.mjs`
- 部分字段 OAM 重构：`stage2-int/tools/ground-oam-reconstructor.mjs`
- 两遍自反馈短试验：`scripts/runImportanceAwareTelemetryPilot.mjs`
- 产物审计：`scripts/testImportanceAwareTelemetryPilotArtifacts.mjs`

主要测试命令：

```powershell
npm run test:int-mc-importance-targets
npm run test:int-mc-importance-metadata
npm run test:int-mc-importance-paths
npm run test:int-mc-self-feedback
node scripts/testImportanceAwareTelemetryPilotArtifacts.mjs --input reports/_scratch/importance-aware-telemetry-pilot-anomaly-base-plus-repair-v7
node scripts/testImportanceAwareTelemetryPilotArtifacts.mjs --input reports/_scratch/importance-aware-telemetry-pilot-telesat-base-plus-repair-v9
```

## 10. 中大型星座 48 时间片扩展结论

扩展产物位于 `reports/importance-aware-telemetry-48slice-medium-large/`。修复大规模 AoI 聚合的调用栈问题和拓扑复用路径的过期 repair 标志后，最终产物已通过完整审计。

| 星座 | 基线字节/节点/片 | 候选字节/节点/片 | 字节变化 | CPU MAE 变化 | 关键 CPU MAE 变化 | AoI 超龄比例变化 | 最大 AoI |
|---|---:|---:|---:|---:|---:|---:|---:|
| Telesat 351 | 394.3162 | 367.7257 | -6.74% | -39.61% | -44.73% | -55.42% | 48 -> 48 |
| Starlink 1584 | 29.9964 | 37.0605 | +23.55% | -13.70% | -14.88% | -14.69% | 48 -> 48 |

该结果支持“重要性感知方案可改善中大型星座全局与关键对象重构质量”，但不支持“在所有规模同时降低实际字节并把最大 AoI 限制在 6 片”。Telesat 的单路径字节下降 23.14%，足以抵消路径数增加；Starlink 的单路径字节仅下降 5.68%，无法抵消路径数增加 30.99%，最终总字节上升。

详细指标、假设判定和可视化见：

- `reports/importance-aware-telemetry-48slice-medium-large/IMPORTANCE_AWARE_48SLICE_REPORT.md`
- `reports/importance-aware-telemetry-48slice-medium-large/importance-aware-48slice-medium-large-report.html`
