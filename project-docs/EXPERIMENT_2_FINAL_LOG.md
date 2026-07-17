# 实验 2 最终日志：原生 INT 基线与 LEO-INT-MC 补强对比

生成日期：2026-07-09

> 当前正式口径已由第 12 节更新。第 6 节和第 11 节保留为历史实验记录，其结果不得替代第 12 节的无真值泄漏重放结论。

## 1. 实验定位

实验 2 的目标是在第一阶段卫星星座真值模型之上，比较不同 INT 遥测策略在覆盖率、遥测开销和状态重构误差之间的权衡关系，并验证面向动态 LEO 卫星网络补强后的 LEO-INT-MC 是否比原生 INT-MC 更适合全网状态感知。

本实验不声称复刻真实运营商内部遥测数据。第一阶段模型提供可控真值，第二阶段 INT / OAM 只能使用已下传的遥测报告进行状态重构，真值只用于实验后的误差检验。

## 2. 对比方法

| 方法 | 含义 | 预期特征 |
|---|---|---|
| 业务流 INT | 只沿业务流路径采集 INT metadata | 开销低，但覆盖依赖业务分布 |
| 全量探测 INT | 主动探测全网，尽可能覆盖全部节点和链路 | 覆盖高，但开销大 |
| 最短路径探测 | 使用最短路径进行主动探测 | 路径短，但可能重复覆盖局部区域 |
| 随机采样 | 随机选择探测路径 | 弱基线，稳定性差 |
| 原生 INT-MC | 选择信息量较高的路径，并用矩阵补全恢复未观测状态 | 在较低开销下恢复全网状态 |
| 增强 LEO-INT-MC | 在原生 INT-MC 上加入卫星时空先验、OAM 反馈、开销感知路径选择和状态一致性补全 | 面向动态卫星网络的低开销全网遥测 |

## 3. 正式规模

实验 2 只围绕三种正式规模展开：

| 规模 | 星座配置 | 用途 |
|---|---:|---|
| 小型 | Iridium 66 | 检查低节点数、稀疏拓扑下的补全稳定性 |
| 中型 | Telesat 351 | 检查传统研究型中等规模 ISL 网络 |
| 大型 | Starlink 1584 | 检查大规模 Walker/Starlink 类主实验场景 |

8x8、47x14 等早期开发规模不再作为正式实验对象。

## 4. 本轮发现的问题

用户指出得很准确：上一轮增强结果存在“看似优化但实际负优化”的风险。

根因有三点：

1. 一些优化把 OAM 反馈过度解释为“必须增加或强约束探测”，在中小规模下反而限制了原生 INT-MC 的发挥。
2. 激进降低直接覆盖率后，小拓扑中少量关键高利用链路漏采，会让补全 MAE 明显反弹。
3. 大规模 Starlink 链路数量很多，负面影响会被庞大的链路样本“稀释”，因此不能只看大型星座结果判断方法有效。

因此本轮不再用“开销下降”单独说明增强有效，而是加入硬约束：

| 指标 | 要求 |
|---|---|
| 活动链路直接观测覆盖率 | 增强后应低于原生 INT-MC，证明不是靠测得更多取胜 |
| 字节/节点/时间片 | 增强后应低于原生 INT-MC，证明遥测开销下降 |
| 利用率补全 MAE | 增强后应不高于原生 INT-MC，证明低开销没有换来更差补全 |

## 5. 本轮修复内容

本轮修复没有针对小型、中型、大型分别写保护规则，而是采用对所有拓扑都适用的统一机制。

1. 增加三指标回归测试：`npm run test:experiment2-efficiency`
   该测试强制检查 Iridium 小规模下增强版是否同时满足更低覆盖、更低开销和不劣 MAE，防止继续用表述掩盖负优化。

2. 修正 OAM 预算压缩策略
   之前的强压缩会把小规模关键路径砍掉，导致 MAE 反弹。现在改为温和压缩，低价值路径降采样，高风险路径保留必要观测。

3. 增加候选路径密集场景的代表性样本保留
   当候选路径集合很大时，多保留少量代表性 probe 路径。该规则按候选路径数触发，不按 Starlink 名称特判。它用于避免大型星座中采样过少导致补全误差轻微反弹。

4. 增加状态张量一致性约束
   当补全器自身已经把链路重构为严重拥塞、长队列、较高误包，且利用率已经处于中高区间时，将利用率抬到 warning 级下限。该规则不读取真值，只约束补全状态之间的物理一致性。

5. 撤回错误的“无业务就低利用率”规则
   第一阶段真值中的利用率不只由业务流量决定，还会受链路状态、队列、拥塞和拓扑上下文影响。因此不能把 `route_task_count=0` 简化为链路一定低利用率。

## 6. 最终关键结果

增强前后 INT-MC 对比结果如下：

| 星座 | 版本 | 直接链路覆盖 | 有效链路覆盖 | 字节/节点/片 | 选择路径数 | 利用率 MAE |
|---|---|---:|---:|---:|---:|---:|
| Iridium 66 | 原生 INT-MC | 71.22% | 100.00% | 517 B | 452 | 7.1165 |
| Iridium 66 | 增强 LEO-INT-MC | 67.13% | 100.00% | 420 B | 436 | 6.8750 |
| Telesat 351 | 原生 INT-MC | 57.54% | 100.00% | 455 B | 536 | 1.0078 |
| Telesat 351 | 增强 LEO-INT-MC | 51.97% | 100.00% | 379 B | 531 | 0.8649 |
| Starlink 1584 | 原生 INT-MC | 3.80% | 100.00% | 24 B | 543 | 2.3646 |
| Starlink 1584 | 增强 LEO-INT-MC | 2.77% | 100.00% | 17 B | 489 | 2.3595 |

结论：三种正式规模上，增强 LEO-INT-MC 都实现了更低直接观测覆盖、更低遥测字节开销，并保持或降低利用率补全 MAE。因此本轮修复后，增强不再是“靠大规模稀释看起来没变差”，而是在小、中、大三种规模上都满足同一组硬约束。

## 7. 实验说明

实验 2 证明的是：在第一阶段高可信仿真真值环境下，补强后的 LEO-INT-MC 相比原生 INT-MC 更适合动态卫星网络低开销全网遥测研究。

它不直接证明真实运营商部署效果，因为真实星间链路占用、星上队列、运营商路由策略、硬件级 INT 支持并未公开。它证明的是算法层面的遥测采样、OAM 重构和矩阵补全机制在动态卫星网络仿真环境中的有效性。

## 8. 大规模实验耗时说明

Starlink 1584 / 48 时间片实验耗时主要来自：

1. 链路-时间片样本规模大；
2. probe INT 会生成大量 hop records 和 reports；
3. Ground OAM 需要构造全局索引、按时间片融合报告、输出重构 CSV/JSON；
4. 矩阵补全需要处理大规模链路状态矩阵；
5. 总体验收脚本比单个实验脚本更重。

本轮采用的优化包括：

1. 每个时间片最多 12 条 INT-MC probe 路径；
2. 使用信息增益 / 遥测成本作为路径评分；
3. 使用边际信息增益和冗余惩罚减少重复测量；
4. 使用拓扑预测和候选路径复用降低重复规划；
5. 使用低采样 + OAM 矩阵补全替代全量直接测量。

## 9. 输出文件

增强前后 INT-MC 对比：

- `reports/experiment2-int-mc-enhanced-comparison-optimized/experiment2-int-mc-enhancement-comparison.html`
- `reports/experiment2-int-mc-enhanced-comparison-optimized/experiment2-int-mc-enhancement-comparison.md`
- `reports/experiment2-int-mc-enhanced-comparison-optimized/experiment2-int-mc-enhancement-comparison.csv`

六方法综合基线对比：

- `reports/experiment2-baseline-comparison-final/experiment2-comprehensive-baseline-report.html`
- `reports/experiment2-baseline-comparison-final/experiment2-comprehensive-baseline-report.md`
- `reports/experiment2-baseline-comparison-final/experiment2-comprehensive-baseline-summary.csv`

## 10. 复现实验命令

重新生成增强前后 INT-MC 对比：

```powershell
npm run experiment:int-mc-enhancement -- --old-root reports/experiment2-native-baseline-rerun-final --out reports/experiment2-int-mc-enhanced-comparison-optimized --int-mc-sampling-rate 0.25 --int-mc-target-active-link-sampling-rate 0.25 --int-mc-iterations 12 --int-mc-window-size 12 --int-mc-warmup-slices 6 --int-mc-max-paths-per-slice 12
```

重新生成六方法综合基线报告：

```powershell
node scripts/writeExperiment2BaselineComparison.mjs --old-root reports/experiment2-native-baseline-rerun-final --original-int-mc-root reports/_archive/experiment2-legacy-baselines/experiment2-constellation-comparison --enhanced-root reports/experiment2-int-mc-enhanced-comparison-optimized --out reports/experiment2-baseline-comparison-final
```

关键回归测试：

```powershell
npm run test:experiment2-efficiency
```

## 11. OAM 强制复测开销优化（2026-07-10）

### 11.1 问题与目标

上一版增强 LEO-INT-MC 在 Starlink 1584 上选择的 probe 路径数从 534 降至 513，但每节点每时间片遥测字节从 23.9419 B 升至 24.5480 B。根因不是 probe 数量，而是 126 条 OAM 强制复测路径平均更长，并继续对沿途节点执行完整邻接扫描。

本轮使用严格非劣化约束：

- 三种星座的新增强版字节/节点/时间片不得高于各自增强前 INT-MC；
- CPU、队列、电量和链路利用率 MAE 相对当前增强版退化不得超过 1%；
- 节点模式和链路状态准确率下降不得超过 0.1 个百分点。

验收脚本为：

```powershell
npm run verify:experiment2-oam-goal -- --reference reports/experiment2-int-mc-energy-physics-final/experiment2-int-mc-enhancement-comparison.json --candidate reports/experiment2-int-mc-oam-optimized-final/experiment2-int-mc-enhancement-comparison.json
```

### 11.2 统一优化机制

1. OAM 强制加分改为边际目标加分。只有路径覆盖尚未覆盖的强制目标时，才能获得强制优先级和预算突破资格。
2. 强制目标记录保持完整 metadata；纯转发记录使用轻量 metadata。
3. 目标邻域裁剪不按星座名称触发，而是使用统一的预计观测损失比例：

\[
r_{loss}=\frac{3\,|V(p)|}{|E_t^{active}|}
\]

当 \(r_{loss}>0.1\) 时保留 all-adjacent；否则使用 target-neighborhood。该门控使中小规模保留高价值邻域观测，大型星座才裁剪占全网比例很低的转发邻域扫描。

### 11.3 正式结果

| 星座 | 增强前 B/节点/片 | 当前增强版 | OAM优化版 | 相对增强前 |
|---|---:|---:|---:|---:|
| Iridium 66 | 517.2121 | 457.6679 | 456.3800 | -11.76% |
| Telesat 351 | 454.9858 | 385.1478 | 385.7642 | -15.21% |
| Starlink 1584 | 23.9419 | 24.5480 | 19.0395 | -20.48% |

| 星座 | CPU MAE | 队列 MAE | 电量 MAE | 链路利用率 MAE | 节点模式准确率 | 链路状态准确率 |
|---|---:|---:|---:|---:|---:|---:|
| Iridium 66 | 0.2097 | 2.3409 | 0.1265 | 1.3399 | 0.9830 | 0.9452 |
| Telesat 351 | 0.9133 | 0.0230 | 0.2858 | 0.3536 | 1.0000 | 0.9985 |
| Starlink 1584 | 0.9584 | 0.0859 | 1.9190 | 2.2061 | 1.0000 | 0.9572 |

严格验收器对三种规模的 21 个门限检查全部通过。Iridium 和 Telesat 保留邻域扫描，六项质量指标与当前增强版一致；Starlink 抑制 2,507 次低价值邻域扫描，遥测字节相对当前增强版下降 22.44%。Starlink 链路利用率 MAE 从 2.1848 变为 2.2061，增加约 0.98%，仍满足 1%门限；CPU、队列和电量 MAE进一步下降。

正式实验中 `oam_duplicate_target_only_suppressed_paths=0`，说明候选集中没有出现满足“只重复目标且不增加链路覆盖”的路径。该防重机制已由单元测试验证，但本轮实际字节收益主要来自目标感知 metadata 和统一观测损失门控，不能把收益归因于未触发的目标去重。

### 11.4 输出文件

- `reports/experiment2-int-mc-oam-optimized-final/experiment2-int-mc-enhancement-comparison.html`
- `reports/experiment2-int-mc-oam-optimized-final/experiment2-int-mc-enhancement-comparison.csv`
- `reports/experiment2-baseline-comparison-oam-optimized-final/experiment2-comprehensive-baseline-report.html`
- `reports/experiment2-baseline-comparison-oam-optimized-final/experiment2-multi-objective-pareto-report.html`

### 11.5 非全知边界

该小节记录的是已归档旧实验的边界问题：旧版 combined feedback 曾混入仿真真值误差辅助反馈，因此不能作为部署型增强方案的正式证据。当前项目不再生成或使用该辅助组，正式结果以第 12 节为准。

## 12. 无真值泄漏正式重放（2026-07-10）

### 12.1 修复内容

本轮直接修复两类数据泄漏，不建立额外 oracle 组：

1. 路径选择器在 `oam-only` 模式下只接收可预测接触图、静态轨道上下文、历史 Ground OAM 节点/链路估计和业务请求的公开字段。第一阶段真实 CPU、队列、电量、利用率、拥塞、丢包和已实现队列时延不会进入路径评分。
2. 补全反馈只由补全置信度、模型分歧、上下文风险、业务热点和 OAM 报告冲突生成。`completion_error_score`、补全值与第一阶段真值之差及 `high-simulation-validation-error` 均已从控制环删除。
3. `oam-only` 入口会拒绝旧格式中带真值误差标记的反馈行，防止误传历史 CSV 后重新引入泄漏。
4. 电量传播使用可预测太阳功率、1200 Wh 电池容量、330 W 静态平均负载和 0.95 充放电效率，不读取第一阶段 `net_power_w` 或运行后负载真值。

第一阶段真值仍用于实验结束后的 MAE、RMSE、F1 和准确率计算，但不会决定采样目标、路径或补全值。

### 12.2 正式结果

| 星座 | 版本 | B/节点/片 | CPU MAE | 队列 MAE | 电量 MAE | 节点模式准确率 | 链路状态准确率 | 链路利用率 MAE | 仅推断利用率 MAE |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Iridium 66 | 增强前 | 506.2424 | 0.3533 | 3.8306 | 0.8709 | 0.9782 | 0.9230 | 2.2232 | 7.4332 |
| Iridium 66 | 增强后 | 437.8505 | 0.2467 | 2.4470 | 0.1343 | 0.9823 | 0.9487 | 1.1725 | 5.6247 |
| Telesat 351 | 增强前 | 426.4387 | 2.1281 | 0.0874 | 1.3873 | 1.0000 | 0.9963 | 0.4525 | 0.9963 |
| Telesat 351 | 增强后 | 399.3001 | 0.9093 | 0.0243 | 0.3150 | 1.0000 | 0.9980 | 0.3467 | 0.9198 |
| Starlink 1584 | 增强前 | 18.6995 | 1.8723 | 0.1681 | 6.3647 | 1.0000 | 0.9573 | 2.4329 | 2.5055 |
| Starlink 1584 | 增强后 | 23.7407 | 0.9599 | 0.0844 | 2.1136 | 1.0000 | 0.9580 | 1.9147 | 1.9914 |

Iridium 与 Telesat 同时降低遥测字节和六类重构误差。Starlink 的 CPU、队列、电量、链路状态和链路利用率重构均改善，但 B/节点/片从 18.6995 增至 23.7407，说明部署边界修复后，大规模反馈复测仍存在开销代价。该结果必须如实保留，不能通过真值辅助选路或规模特判掩盖。

### 12.3 实验边界

当前实现是两阶段无真值泄漏 replay：第一轮生成 Ground OAM 和可部署反馈，第二轮使用这些结果重新规划 48 个时间片。它已经消除真值控制泄漏，但还不是严格的在线逐时间片闭环。严格在线版本应在时间片 `t` 结束后只允许使用不晚于 `t` 的报告来规划 `t+1`。

### 12.4 正式输出

- `reports/experiment2-int-mc-oracle-free-replay/experiment2-int-mc-enhancement-comparison.html`
- `reports/experiment2-int-mc-oracle-free-replay/experiment2-int-mc-enhancement-comparison.csv`
- `reports/experiment2-int-mc-oracle-free-replay/experiment2-int-mc-enhancement-comparison.json`
- `reports/experiment2-baseline-comparison-oracle-free-replay/experiment2-comprehensive-baseline-report.html`
- `reports/experiment2-baseline-comparison-oracle-free-replay/experiment2-multi-objective-pareto-report.html`

## 13. 重要性感知选择性遥测短回放（2026-07-13）

本轮在实验 2 增强方案之上增加了严格因果的重要对象评分、有界增量修复路径和逐跳字段 mask。其研究问题是：在不改变第一阶段真值模型、也不允许规划器读取当前隐藏状态的前提下，能否只让必要节点或链路写入 INT metadata，从而同时降低实际遥测字节、控制最大 AoI，并保持全局和关键对象重构质量。

最终两组短回放结果如下：

| 场景 | 时间片 | 基线总字节 | 候选总字节 | 字节变化 | CPU MAE | 队列 MAE | 电量 MAE | 链路利用率 MAE | 最大 AoI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 节点高负载异常 | 24 | 961188.864 | 799520 | -16.82% | 2.0496 -> 1.3420 | 2.5882 -> 1.9086 | 0.2804 -> 0.1860 | 0.4714 -> 0.3000 | 6 -> 3 |
| Telesat 27x13 | 12 | 1683118.080 | 1524624 | -9.42% | 1.0834 -> 0.7331 | 0.0730 -> 0.0419 | 0.7843 -> 0.5978 | 0.4289 -> 0.2912 | 11 -> 6 |

高负载场景的 CPU 异常召回从 0.9385 提升至 0.9692，异常宏召回从 0.9795 提升至 0.9897。Telesat 短场景缺少足够异常正样本，因此只证明开销、误差和 AoI 门禁通过，不用于支持异常召回结论。两组产物的因果违规数均为 0，并通过实际字节分解审计。

该结果是核心机制的短回放证据，不替代实验 2 的 48 时间片、多种子正式统计。完整算法、数学定义、关键代码、审计命令和声明边界见 `project-docs/IMPORTANCE_AWARE_SELECTIVE_TELEMETRY_PILOT.md`。
