# 动态等预算机制消融实验设计

## 1. 目标

在三种规模的动态 LEO 星座上，以相同的逐时间片实际遥测硬字节预算，逐组移除增强 LEO-INT-MC 的关键机制，回答以下问题：

1. 中大型星座上的 CPU、队列和电量重构收益来自哪些机制？
2. 拓扑复用、预测和轨道先验是否只在高动态性下有价值？
3. Iridium 小型星座中的退化由哪一类额外机制引起？
4. 机制收益是否在 10 个配对种子下具有稳定置信区间，而不是单次运行偶然结果？

实验不修改第一阶段 Walker/TLE-SGP4、链路预算、业务、能量或路由模型，只复用第一阶段动态真值并改变第二阶段遥测与重构机制。

## 2. 实验矩阵

### 2.1 星座规模

- `iridium-next-small`：66 节点；
- `telesat-1015-medium`：351 节点；
- `starlink-main-large`：1584 节点。

### 2.2 动态性

- `0%`：受控下线集合成员固定，用作相对静态控制组；
- `25%`：每时间片替换约四分之一受控集合成员，用作高动态压力组。

不运行 10% 中间档。0% 和 25% 足以估计机制贡献及其动态性交互，同时避免重复 Experiment 10 的全部三档成本。

### 2.3 配对种子

使用 `experiment11-seed-00` 至 `experiment11-seed-09` 共 10 个种子。同一星座、动态档和种子下，完整组及所有消融组共享完全相同的第一阶段真值、业务和链路扰动轨迹。

### 2.4 实验组

完整组启用当前 Experiment 8/10 正式增强方案中的全部 11 个有效机制开关。五个消融组每次只关闭一个互斥机制集合：

| 实验组 | 关闭机制 | 研究问题 |
|---|---|---|
| `full-enhanced` | 无 | 完整增强参照 |
| `without-topology-adaptation` | `adaptiveReuse`、`incrementalTopologyRepair` | 拓扑复用和局部修复的贡献 |
| `without-forecast-orbit-priors` | `forecastRiskScoring`、`orbitGraphRegularization`、`orbitPeriodicPrior` | 接触预测与轨道时空先验的贡献 |
| `without-node-state-coupling` | `nodeStateCoupling`、`jointStateCoupling` | 节点状态耦合的贡献 |
| `without-energy-physics-prior` | `nodeEnergyPhysicsPrior` | 能量物理先验的独立贡献 |
| `without-tensor-traffic-context` | `metricTensorCoupling`、`stateTensorJointCompletion`、`businessHotspotMigrationPrior` | 张量及业务热点上下文的贡献 |

`adaptiveProbeBudget`、`oamQualityFeedback`、`multiObjectiveBudget` 和 `oamTargetAwareMetadata` 在当前正式增强方案中本来就是关闭状态，因此不纳入消融。对本来未启用的机制做消融不会产生有效因果比较。

总方法场景数为：

\[
3\text{ profiles}\times2\text{ stress levels}\times10\text{ seeds}\times6\text{ variants}=360.
\]

## 3. 严格预算公平性

沿用 Experiment 10 冻结的每节点每时间片硬字节上限：

- Iridium：`476.2424 B/节点/片`；
- Telesat：`435.7265 B/节点/片`；
- Starlink：`21.3359 B/节点/片`。

probe 成本按 base、逐跳 metadata 和 report 字节核算。超限 probe 在发送前拒绝。所有完整组和消融组使用无信息 padding 对齐实际网络负载：

- padding 计入报告转发、链路承载和能耗；
- padding 不携带 INT metadata；
- padding 不增加节点或链路覆盖；
- padding 不参与 Ground OAM 重构。

每个星座、动态档和种子的 6 个组必须满足：

\[
B_{v,t}\le B_t^{\max},\qquad
\max_v B_v-\min_v B_v\le10^{-4}\text{ B/节点/片}.
\]

## 4. 数据流与复用

Experiment 11 直接复用 `runExperiment8`：

1. 每个星座、种子和动态档只生成一次第一阶段动态真值；
2. 6 个消融组共享输入目录和候选路径；
3. 每组独立执行路径选择、probe/report、Ground OAM 和矩阵补全；
4. 每个种子完成后提取紧凑结果并删除大体积中间输入和运行目录；
5. `seed-result.json` 使用参数、输入和实现指纹支持断点续跑。

这样既保持因果公平性，也避免每个消融组重复生成第一阶段网络。

## 5. 指标和数学定义

主要指标：

- `cpu_mae`；
- `queue_depth_mae`；
- `energy_percent_mae`；
- `node_mode_accuracy`；
- `link_utilization_mae`；
- `link_status_accuracy`；
- `planning_wall_time_ms`；
- `reconstruction_wall_time_ms`；
- `telemetry_padding_bytes_per_node_slice`；
- `invalid_probe_path_ratio`。

机制贡献按指标方向统一定义。对误差和开销指标：

\[
\Delta_{m,s,d}=x_{\text{ablated},s,d}-x_{\text{full},s,d}.
\]

对准确率指标：

\[
\Delta_{m,s,d}=x_{\text{full},s,d}-x_{\text{ablated},s,d}.
\]

因此 \(\Delta>0\) 始终表示移除机制后结果变差，即该机制产生正向贡献。

动态性交互效应定义为：

\[
I_{m,s}=\Delta_{m,s,25\%}-\Delta_{m,s,0\%}.
\]

若 \(I>0\) 且 95% 置信区间不跨 0，说明该机制在高动态拓扑下的贡献显著增强。

每个贡献和交互项均报告：

- 配对均值；
- 样本标准差；
- Student-t 95% 置信区间；
- Cohen \(d_z\)。

## 6. 验收门禁

正式结果必须同时满足：

1. 360 行方法级原始结果完整；
2. 3 星座 × 2 动态档 × 10 种子 × 6 组无重复或缺失；
3. 60 个星座/动态档/种子公平场景全部通过；
4. 所有方法 `telemetry_byte_budget_cap_violations = 0`；
5. 每个公平场景的主组实际字节差不超过 `1e-4 B/节点/片`；
6. 每个种子记录输入哈希、实现指纹和配置指纹；
7. 报告保留稳定负向和置信区间跨 0 的结果；
8. HTML 为 UTF-8 中文且不存在乱码或替换字符；
9. 相关单元测试、产物测试和 `npm run build` 通过。

## 7. 产物

正式目录：

`reports/experiment11-dynamic-equal-budget-ablation`

输出：

- `experiment11-ablation-by-seed.csv`；
- `experiment11-ablation-aggregate.csv`；
- `experiment11-mechanism-contributions.csv`；
- `experiment11-dynamicity-interactions.csv`；
- `experiment11-budget-fairness.csv`；
- `experiment11-summary.json`；
- `experiment11-manifest.json`；
- `experiment11-dynamic-ablation-report.html`；
- 根目录 `EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md`。

报告至少包含预算公平性表、误差置信区间图、机制贡献热力图、0%/25% 交互图、逐规模结论和负结果边界。

## 8. 结论边界

该实验识别仿真环境中机制组的因果贡献，不证明真实星载硬件中的绝对收益。机制组内部仍包含多个开关，因此只能归因到机制类别，不能归因到单一代码开关。若某组贡献稳定且需要进一步拆解，再在后续实验中对该组做细粒度消融。
