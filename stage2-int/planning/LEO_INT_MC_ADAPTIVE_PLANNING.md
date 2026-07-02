# LEO INT-MC 自适应遥测规划说明

本文档说明第二阶段中面向动态 LEO 卫星网络的 INT-MC 改造。它不是把地面网络里的 Mininet/P4 原型直接搬进卫星网络，而是在当前项目已有的 `probe-int` 遥测管线之上，增加低开销采样、轨道预测、拓扑复用、Ground OAM 重构和矩阵补全能力。

## 1. 与原生全网 INT 的对齐口径

后续对比实验应使用同一套阶段一真值、同一套 probe/hop/report/OAM 数据结构。

- 原生全网感知 INT：`path-balance` 或 `path-original`，目标是逐时间片尽量完整观测节点和链路状态。
- LEO-INT-MC：`int-mc`，目标是只采样部分 probe 路径，再由 Ground OAM 进行链路与节点矩阵补全。
- 对齐检查：`npm run int:align -- --run <run-dir>` 会把当前项目的 hop metadata、report、OAM 重构结果映射到 INT-MC 可对比字段。

关键区别是：原生 INT 的观测覆盖率应接近全网；INT-MC 的直接观测覆盖率可以较低，但需要比较补全后的误差、遥测字节数、能耗开销和重构覆盖率。

## 2. 拓扑预测驱动

`predict-contact-plan.mjs` 会根据阶段一导出的轨道和链路物理状态生成预测接触计划：

```text
stage1 truth links/nodes
  -> predicted-contact-plan.json
  -> int-mc-path-selector.mjs
  -> selected probe paths
```

预测接触计划不读取业务负载真值来决定运行时状态，而是使用以下物理约束：

- 视距与地球遮挡；
- 距离阈值；
- 链路容量与 SNR 门限；
- 天线可用性与指向；
- 极区限制、太阳规避、限制原因标签。

新增滚动 K 步预测窗口产物：

```text
predicted-contact-plan-windows.csv
predicted-topology-forecast.csv
```

该文件回答两个问题：在某个时间片启动规划时，未来多少个时间片可以被预测；在这个预测窗口内，哪些拓扑类可以复用，哪些时间片需要重新规划。

`predicted-topology-forecast.csv` 进一步把预测结果压缩到每个时间片的控制面信号：

```text
topology_forecast_stable_window_slices
topology_forecast_next_class_transition_in_slices
topology_forecast_next_major_drift_in_slices
topology_forecast_mean_active_jaccard
topology_forecast_min_active_jaccard
topology_forecast_drift_pressure
topology_forecast_reuse_confidence
topology_forecast_recommended_plan_mode
```

其中稳定窗口表示当前拓扑预计还能复用多少个时间片；`drift_pressure` 表示未来窗口内 active-link 集合和拓扑类发生变化的压力；`recommended_plan_mode` 会给出 `reuse-probe-plan`、`reuse-with-local-repair` 或 `preemptive-replan`。这样路径选择器可以在拓扑真正变化之前适度提高 active-link 采样目标，而不是等变化发生后再被动重算。

现在路径选择器还会把未来 K 个时间片的接触预测直接写入候选 probe path 的评分，而不只是用于“复用/重算”判断。每条链路会在当前时间片生成以下预测特征：

```text
forecast_horizon_slices
forecast_transition_count
forecast_transition_score
forecast_first_change_in_slices
forecast_first_down_in_slices
forecast_first_up_in_slices
forecast_near_change_score
forecast_near_outage_score
forecast_contact_scarcity_score
forecast_availability_risk
forecast_priority_score
```

含义是：如果某条星间链路在未来窗口内即将断开、可用性快速下降、频繁切换，或者处于短接触窗口边界，那么它在当前片被探测的价值更高。`int-mc-leverage` 会把该预测优先级作为信息量增益，`topology-aware` 会把它视为动态拓扑重点区域，`orbit-predicted` 会进一步提高这类链路的权重。这样 probe 方案不是被动等待拓扑变化后重新计算，而是在变化发生前优先采样高价值链路。

相关参数：

```text
--prediction-score-horizon 4
--int-mc-prediction-score-horizon 4
```

相关输出：

```text
probe-paths-int-mc.csv
probe-summary-int-mc.csv
probe-sampling-mask-int-mc.csv
probe-coverage-int-mc.json
```

在低开销遥测场景下，仅知道“哪条路径信息量大”还不够，还需要知道“为这条路径付出多少 INT 开销”。因此 `int-mc-path-selector.mjs` 现在会在选择前估算每条候选 probe path 的遥测成本：

```text
estimated_metadata_bytes
estimated_report_bytes
estimated_probe_forward_bytes
estimated_generated_telemetry_bytes
estimated_total_telemetry_bytes
estimated_processing_energy_j
estimated_tx_energy_j
estimated_total_telemetry_energy_j
cost_aware_value_per_kb
cost_aware_score
```

估算使用和 `probe-int-runner.mjs` 一致的默认口径：每跳 metadata 96 B、probe base 64 B、report header 128 B、每跳处理 0.02 J、report 处理 0.05 J、传输 120 nJ/B。真实实验结束后的开销仍以 `probe-int-overhead-by-slice-*.csv`、`probe-int-link-overhead-*.csv` 和 `probe-int-node-overhead-*.csv` 为准；这里的估算只用于规划阶段排序，让 INT-MC 在相近观测价值下倾向选择更短、更省字节和更省能耗的路径。

相关参数：

```text
--cost-aware-sampling true
--cost-awareness-weight 0.28
--int-mc-cost-aware-sampling true
--int-mc-cost-awareness-weight 0.28
```

如果需要模拟更严格的遥测资源限制，可以打开每时间片软字节预算：

```text
--telemetry-byte-budget-per-slice 24000
--int-mc-telemetry-byte-budget-per-slice 24000
```

预算策略是 soft budget：超过预算的普通路径会被抑制并计入 `telemetry_budget_suppressed_paths`；但如果路径覆盖当前仍缺失的目标链路、命中 Ground OAM 优先复测目标，或预测窗口显示临近断链，则允许 `critical-coverage-override`，并记录 `telemetry_budget_override_paths`、`telemetry_budget_overrun_bytes`、`telemetry_budget_utilization`。这样可以表达卫星遥测中的现实约束：低开销是目标，但不能因为预算完全放弃关键异常或即将消失的接触窗口。

## 3. 自适应拓扑复用阈值

卫星网络的拓扑很少完全相同。如果要求完全相同才复用，INT-MC 会退化成每个时间片都重新规划；如果相似度阈值过低，又会错误复用旧 probe 方案。当前实现采用多维相似度和自适应阈值。

拓扑相似度包含：

```text
active-link Jaccard
inter-plane-link Jaccard
bottleneck-link Jaccard
route-path Jaccard
link-state matrix similarity
utilization similarity
latency similarity
availability similarity
```

其中 `link-state matrix similarity` 会把每条链路的 active、utilization、congestion、latency、availability 归一化后比较，避免只看“链路是否存在”而忽略链路状态已经明显变化。

复用阈值不是随机设置，而是按风险调节：

```text
threshold =
  base threshold
  + volatility penalty
  + bottleneck penalty
  + load penalty
  + contact uncertainty penalty
  + structural drift penalty
  + link-state drift penalty
  + route drift penalty
  + OAM pressure penalty
  - stability credit
  - overhead pressure credit
```

含义是：拓扑更不稳定、瓶颈更多、负载更高、预测可用性更低、与最近拓扑类的链路/路径/状态漂移更大、Ground OAM 对当前片更不确定时提高阈值；遥测规划开销压力更大且历史相似度稳定时降低阈值。这样阈值不是随机或凭经验拍脑袋，而是每个时间片都有可解释的收紧/放宽来源。

新增可解释字段包括：

```text
adaptive_threshold_base
adaptive_threshold_policy
adaptive_threshold_reason
adaptive_threshold_total_tightening
adaptive_threshold_total_relaxation
adaptive_threshold_volatility_penalty
adaptive_threshold_bottleneck_penalty
adaptive_threshold_load_penalty
adaptive_threshold_contact_uncertainty_penalty
adaptive_threshold_structural_drift_penalty
adaptive_threshold_link_state_drift_penalty
adaptive_threshold_route_drift_penalty
adaptive_threshold_oam_pressure_penalty
adaptive_threshold_stability_credit
adaptive_threshold_overhead_credit
adaptive_threshold_calibration_policy
adaptive_threshold_calibration_evidence_count
adaptive_threshold_calibration_candidate_class_count
adaptive_threshold_calibration_future_window_slices
adaptive_threshold_calibration_best_second_gap
adaptive_threshold_calibration_class_density
adaptive_threshold_calibration_future_mean_similarity
adaptive_threshold_calibration_future_min_similarity
adaptive_threshold_calibration_ambiguity_penalty
adaptive_threshold_calibration_future_drift_penalty
adaptive_threshold_calibration_separation_credit
adaptive_threshold_calibration_future_stability_credit
adaptive_threshold_calibration_sample_support_credit
adaptive_threshold_calibration_evidence_confidence
adaptive_threshold_calibration_net_adjustment
topology_reuse_margin
```

其中 `topology_reuse_margin = topology_similarity_score - adaptive_reuse_threshold`。如果该值为负，说明当前片即使找到最相似拓扑类，也不足以安全复用，需要 fresh replan；如果为正且没有 OAM 强制重规划，则可以复用已有 probe 方案并做局部修复。

进一步地，当前实现还加入了阈值校准层。它不是把阈值固定成某个经验数，而是从当前预测窗口内计算：

- 当前时间片与已有拓扑类的相似度分布；
- 最相似类和第二相似类的间隔；
- 有多少拓扑类靠近复用阈值；
- 未来若干预测时间片与当前片的相似度；
- 样本证据量和证据置信度。

如果最相似类和第二相似类太接近，说明复用决策容易误判，`adaptive_threshold_calibration_ambiguity_penalty` 会提高阈值；如果未来几个时间片很快发生漂移，`adaptive_threshold_calibration_future_drift_penalty` 会提高阈值；如果最相似类分离度很高且未来窗口稳定，则 `adaptive_threshold_calibration_separation_credit`、`adaptive_threshold_calibration_future_stability_credit` 和 `adaptive_threshold_calibration_sample_support_credit` 会适当降低阈值。这样阈值来自“风险项 + 预测窗口统计校准”，而不是随机选取或凭感觉设定。

## 4. Probe 方案复用与局部修复

当当前时间片与已有拓扑类足够相似时，`int-mc-path-selector.mjs` 会尝试复用该拓扑类已有的 probe 方案：

1. 取该拓扑类上一次选出的 probe path；
2. 映射到当前时间片；
3. 检查路径中的链路是否仍然可用；
4. 如果部分链路失效，在当前预测图上做局部最短路修复；
5. 如果修复失败，才退回当前时间片 fresh plan。

相关字段：

```text
candidate_source
topology_reuse_decision
topology_similarity_score
link_state_similarity
adaptive_reuse_threshold
adaptive_threshold_reason
topology_reuse_margin
planning_repair_count
estimated_full_replanning_avoided
planning_reuse_mode
planning_cache_hit
planning_full_replan_cost_units
planning_actual_cost_units
planning_cost_saved_units
planning_cost_saving_ratio
```

`planning_*_cost_units` 是相对归一化规划开销，不是机器实测 CPU 时间。它用于表达同一组时间片下“每片全量重规划”的基线成本，与“拓扑类缓存复用 + 预测图局部修复”的实际成本差异。这样后续即使暂时不做正式实验，也能在产物里直接看到：哪些时间片命中缓存、哪些时间片因为 OAM 压力或拓扑变化重新规划、局部修复带来了多少额外开销，以及总体估计节省率是多少。

## 5. 低开销采样策略接口

为了后续做消融和对比实验，`int-mc-path-selector.mjs` 新增统一采样策略接口：

```powershell
--selection-strategy full-int
--selection-strategy int-mc-leverage
--selection-strategy random-sampling
--selection-strategy shortest-path
--selection-strategy topology-aware
--selection-strategy orbit-predicted
```

通过总控脚本运行时使用：

```powershell
npm run int:experiment -- --algorithm int-mc --int-mc-selection-strategy topology-aware
```

各策略含义：

- `full-int`：选择当前时间片全部候选 probe path，作为高开销全量观测上限；
- `int-mc-leverage`：默认策略，优先采样矩阵补全信息量高、动态性强、长时间未观测的链路；
- `random-sampling`：确定性随机基线，便于和论文中的随机采样比较；
- `shortest-path`：最短路径基线，代表低路径开销但信息量未必最优；
- `topology-aware`：优先轨间链路、瓶颈链路和变化链路，体现卫星拓扑知识。
- `orbit-predicted`：优先选择预测可用性高、未来接触风险低、动态链路信息量高的 probe path，体现轨道/contact-plan 预测。

`int-mc-path-selector.mjs` 还会输出显式采样矩阵：

```text
probe-sampling-mask-<algorithm>.csv
```

该文件按 `slice_index × link_id` 展开，每一行表示某个时间片的一条链路在 INT-MC 采样计划中的角色。关键字段包括：

```text
active_mask_value
sampling_mask_value
completion_role
selected_probe_count
selected_probe_ids
topology_class_id
planning_reuse_mode
leverage_score
transition_rate
```

其中 `active_mask_value=0` 表示该链路在预测 contact plan 中物理不可用，矩阵补全阶段应保持 `topology-down-mask`；`active_mask_value=1` 且 `sampling_mask_value=1` 表示该链路被 probe 计划直接采样；`active_mask_value=1` 且 `sampling_mask_value=0` 表示该链路可用但未直接采样，后续由 Ground OAM / INT-MC 补全估计。这使“低开销采样”不再只体现在 probe path 列表里，而是有了标准的矩阵补全观测掩码。

## 6. 能耗开销与低电量降频

`traffic-int` 和 `probe-int` 的 run report 都包含遥测能耗估计：

```text
processing_energy_j
tx_energy_j
total_telemetry_energy_j
total_telemetry_energy_wh
```

同时，离线实验会输出统一口径的开销明细，方便把原生全网 `probe-int`、业务路径 `traffic-int` 和低采样 `int-mc` 放在同一张表里比较：

```text
traffic-int-overhead-by-slice.csv
traffic-int-link-overhead.csv
traffic-int-node-overhead.csv
probe-int-overhead-by-slice-<algorithm>.csv
probe-int-link-overhead-<algorithm>.csv
probe-int-node-overhead-<algorithm>.csv
```

其中 `*-overhead-by-slice.csv` 记录每个时间片的 hop records、reports、metadata bytes、report bytes、total INT bytes 和遥测能耗；`*-link-overhead.csv` 记录每条链路在该时间片承载了多少 INT 探测/metadata 转发字节；`*-node-overhead.csv` 按时间片和卫星节点记录该节点承担的 INT metadata 处理、probe 转发、report 生成/转发、星地回传字节、遥测 CPU cost 和能耗估计。这样后续做 INT-MC 对比时，可以同时报告：

- 覆盖率和重构误差；
- 直接观测率与补全率；
- 每时间片 INT 字节数；
- 每链路遥测负载峰值；
- 每节点遥测处理与发送能耗；
- 阴影区、低电量或节能模式节点承担的遥测负担是否被控制。

低电量节点不会被完全隐藏，但会降低本地相邻链路扫描比例：

```text
low_energy_scan_threshold_percent
low_energy_adjacent_scan_ratio
low_energy_scan_limited_nodes
suppressed_adjacent_link_scans
```

`int-mc` 路径选择还加入了更细的 energy guard。每条候选 probe path 会记录：

```text
predicted_energy_risk
predicted_shadow_nodes
predicted_low_energy_nodes
predicted_power_saving_nodes
mean_path_solar_exposure
mean_path_power_margin_w
energy_guard_decision
```

其逻辑是：低电量、节能模式、阴影区、太阳曝光不足、`net_power_w < 0` 都会提高路径能量风险。选择器不会简单禁止这些路径；如果它们能覆盖关键未测链路，仍允许以 `critical-coverage-override` 方式选入。若只是重复覆盖或非必要测量，则会被 `energy_guard_suppressed_paths` 统计为被抑制的候选路径。这对应卫星网络里“阴影区减少非必要测量、低电量降低遥测频率，但关键异常仍需保留遥测能力”的控制逻辑。

现在 `int-mc` 路径选择还会按时间片生成能耗感知采样预算。该预算会根据候选路径的平均能量风险、阴影节点比例、低电量节点比例、低太阳曝光比例和负功率余量压力，降低当前片的有效采样率；如果 Ground OAM 对某些异常目标有较高复测压力，则会给出 `energy_budget_critical_coverage_credit`，避免关键异常被过度降频。相关字段会写入 `probe-summary-int-mc.csv`、`probe-sampling-mask-int-mc.csv` 和 `probe-coverage-int-mc.json`：

```text
effective_sampling_rate
effective_target_active_link_sampling_rate
energy_budget_policy
energy_budget_reason
energy_budget_scale
energy_budget_pressure
energy_budget_critical_coverage_credit
energy_budget_requested_paths
energy_budget_target_covered_links
energy_budget_suppressed_paths
energy_budget_deferred_active_links
energy_budget_shadow_node_ratio
energy_budget_low_energy_node_ratio
energy_budget_low_solar_node_ratio
energy_budget_power_deficit_pressure
```

这使后续实验可以比较：全量 INT、低采样 INT-MC、能量约束 INT-MC 在遥测字节数和遥测能耗上的差异。

## 7. Ground OAM 重构

Ground OAM 是地面运维与控制平面。它不能直接读取第一阶段真值，只能依赖已下传的 INT report 来重构全网状态。

当前 Ground OAM 支持：

- 多报告融合；
- 冲突惩罚；
- 过期观测 carry-over；
- 置信度衰减；
- unknown / stale / observed 区分；
- 优先复测目标生成；
- 每个时间片的 OAM 控制动作生成。

关键输出：

```text
ground-reconstructed-nodes.csv
ground-reconstructed-links.csv
ground-oam-estimate-graph.json
ground-oam-priority-retest.csv
ground-oam-control-actions.csv
ground-oam-evaluation.json
```

其中 `ground-oam-estimate-graph.json` 是 Ground OAM 的全网状态估计图。它按时间片组织节点和链路估计状态、observed/stale/unknown 来源、置信度、冲突率和优先复测目标。该图用于表达控制面对全网的“当前认知”，不是直接展示第一阶段真值。

Ground OAM 的置信度不是单一常数。多条 INT report 指向同一个节点/链路时，OAM 会对离散状态做多数融合，对连续指标做均值融合，并计算：

```text
confidence_before_decay
confidence_decay_factor
confidence_state
state_age_slices
conflict_severity
categorical_conflict_ratio
numeric_conflict_ratio
fusion_confidence_penalty
fusion_sample_support
fusion_method
```

`confidence_before_decay` 表示报告融合后的基础置信度；`confidence_decay_factor` 表示 stale carry-over 的半衰期衰减因子；`state_age_slices` 表示该状态距离最近一次真实下传观测已经过去了多少时间片；`conflict_severity` 同时考虑离散状态分歧和连续数值离散程度。这样 OAM 可以区分“刚观测但报告冲突”和“很久没观测但没有冲突”的两类风险。

Ground OAM 还包含一个轻量级先验估计层：当某个节点或链路在当前时间片既没有被 INT 直接观测，也没有可用的 stale carry-over 时，OAM 会尝试使用同一时间片、同一空间分组或历史分组的已下传报告统计值生成 `oam-prior-estimate`。这类估计带有较低置信度，只用于控制面判断和优先复测，不计入 `observed` 覆盖率，也不代表已经真实测到该对象。

`ground-oam-control-actions.csv` 是新增的控制面动作表。它按时间片聚合 OAM 自己掌握的状态质量，而不是第一阶段真值，计算：

```text
oam_control_pressure
unknown_pressure
stale_pressure
prior_estimate_pressure
low_confidence_pressure
conflict_pressure
stale_age_pressure
confidence_debt_pressure
fusion_conflict_pressure
downlink_pressure
retest_pressure
coverage_demand_pressure
```

然后给出 `recommended_action`：

```text
maintain-current-plan
schedule-priority-retest
refresh-probe-plan
```

这表示 Ground OAM 可以根据自身认知质量决定下一轮遥测动作：状态健康时维持当前方案；低置信或 unknown 较多时安排优先复测；控制压力过高时建议刷新 probe 计划。该动作层仍然遵守非全知边界，只使用已下传 INT reports、stale carry-over 和 OAM prior estimates。

为了让闭环控制不只停留在“是否重规划”，Ground OAM 现在还会输出下一轮遥测预算建议：

```text
recommended_sampling_rate
recommended_target_active_link_sampling_rate
recommended_telemetry_byte_budget_per_slice
recommended_downlink_budget_bytes
budget_recommendation_action
budget_recommendation_reason
budget_recommendation_source
```

这些建议由 OAM 自己看到的 unknown/stale、低置信、冲突、优先复测和下传压力计算得到，不读取第一阶段真值。含义是：当全网估计图中 unknown 或低置信目标增多时，提高关键 probe 采样和遥测字节预算；当下传压力过大时，压低非关键遥测预算，避免 INT report 挤占过多星地回传能力。

为了让 OAM 从“事后展示”变成“控制闭环”，`int-mc-path-selector.mjs` 现在支持读取上一轮 OAM 输出：

```powershell
--oam-priority-retest stage2-int/runs/<previous-run>/stage2-int/ground-probe-int-mc/ground-oam-priority-retest.csv
--oam-feedback-weight 0.35
--oam-replan-pressure-threshold 0.68
```

该文件中的 `node` 目标会匹配候选 probe path 的路径节点，`link` 目标会匹配路径链路。命中的候选路径会获得 `oam_feedback_score`，并输出：

```text
oam_feedback_targets
oam_feedback_link_targets
oam_feedback_node_targets
oam_feedback_target_ids
oam_feedback_reasons
```

这使下一轮 probe 规划可以优先覆盖低置信度、过期、unknown、拥塞告警或冲突报告目标，形成“INT 观测 -> Ground OAM 重构 -> 优先复测 -> 下一轮 probe 选择”的闭环。默认不传该文件时，现有实验行为不变。

进一步地，OAM 复测目标不只会影响候选路径得分，也会影响拓扑复用决策。选择器会按时间片把 `priority_score`、unknown/stale/conflict/warning/congestion 等原因聚合成 `oam_replan_pressure`。当该压力超过 `oam_replan_pressure_threshold` 时，即使当前拓扑和已有拓扑类相似，也会触发 `oam-feedback-refresh-replan`，强制刷新该时间片的 probe 方案。这对应真实控制面中的逻辑：拓扑相似时可以复用计划，但如果 Ground OAM 对关键节点或链路的认知已经明显退化，就不应继续无条件复用旧采样方案。

新增输出字段包括：

```text
oam_replan_pressure
oam_replan_targets
oam_replan_urgent_targets
oam_replan_pressure_threshold
oam_replan_triggered
```

控制动作也可以作为下一轮 INT-MC 路径选择的闭环输入：

```powershell
npm run int:experiment -- --algorithm int-mc --int-mc-oam-control-actions stage2-int/runs/<previous-run>/stage2-int/ground-probe-int-mc/ground-oam-control-actions.csv
```

接入后，路径选择器会在 `probe-paths-int-mc.csv`、`probe-summary-int-mc.csv`、`probe-sampling-mask-int-mc.csv` 和 `probe-coverage-int-mc.json` 中写入 `oam_control_action`、`oam_control_pressure`、`oam_control_replan_triggered`、`oam_control_selected_paths` 等字段。这样后续对比实验可以把原生全网 Probe-INT 作为全测基线，把 INT-MC 作为“低开销采样 + Ground OAM 补全 + 控制动作反馈”的闭环方法，比较覆盖率、误差、遥测字节、遥测能耗和重新规划开销。

如果 `ground-oam-control-actions.csv` 中包含预算建议，路径选择器还会按时间片应用 OAM 建议的采样率、active-link 采样目标和遥测字节预算。相关字段包括：

```text
oam_budget_applied
oam_budget_policy
oam_budget_action
oam_budget_reason
oam_recommended_sampling_rate
oam_recommended_target_active_link_sampling_rate
oam_recommended_telemetry_byte_budget_per_slice
oam_recommended_downlink_budget_bytes
```

这样 INT-MC 的低开销约束可以从固定命令行参数升级为 OAM 驱动的闭环控制：上一轮遥测质量差的时间片会倾向于增加采样或刷新计划；下传压力高的时间片会倾向于收紧预算，只保留关键覆盖或优先复测路径。

## 8. 卫星空间先验矩阵补全

`int-mc-reconstructor.mjs` 不仅做链路矩阵补全，也补全节点状态矩阵。补全时加入卫星网络空间先验：

- 同轨道面链路相似；
- 相邻轨道面链路相似；
- 相近槽位链路相似；
- 轨内链路与轨间链路分组处理；
- 节点按轨道面 band 和槽位 band 分组；
- 平面-槽位-时间张量邻域相似：同轨相邻槽位、相邻轨道面同槽位在同一时间片内可作为低置信先验。

补全初始化和置信度现在还包含动态上下文先验：

```text
temporal-neighbor
tensor-neighbor
same-slice-spatial-group
same-slice-all-groups
historical-spatial-group
low-rank reconstruction
```

含义是：缺失的链路/节点状态会优先融合同一对象相邻时间片的已观测值和平面-槽位张量邻居的同时间片已观测值；当前默认时间邻居权重为 0.7，张量邻居权重为 0.3。若其中一类先验不可用，则退化为另一类可用先验；之后再参考同一时间片同空间组的已观测值，最后进入低秩矩阵补全。置信度会结合可预测的 contact availability、太阳/阴影状态、功率余量等上下文调节。注意这些上下文只作为结构性先验和置信度依据，不把第一阶段隐藏的目标指标直接填入遥测结果。

为了让补全结果可解释，链路和节点重构行现在还会输出上下文标签：

```text
context_prior_strength
context_prior_risk
context_prior_tags
latitude_context
illumination_context
link_availability_context
link_distance_to_threshold_ratio
```

链路侧标签会标记 `polar-region`、`inter-plane-latitude-sensitive`、`solar-interference-risk`、`near-range-limit`、`congested`、`business-hotspot` 等场景；节点侧标签会标记 `sunlit/shadow`、`low-solar-exposure`、`low-energy`、`power-saving`、`high-queue`、`traffic-hotspot` 等场景。它们的作用是解释 INT-MC 置信度和后续误差分析，不把未观测状态直接替换成真值。

张量邻域先验的边界是：只使用 Ground OAM 已收到的 INT reports 中的同时间片邻居观测。例如 `P03-S04` 的节点状态可以参考 `P03-S03`、`P03-S05`、`P02-S04`、`P04-S04` 的已观测状态；链路状态则参考整体平移后的相邻链路。未被遥测观测到的邻居不会被当成真值使用。

链路补全输出：

```text
ground-mc-reconstructed-links.csv
int-mc-link-errors.csv
int-mc-matrix-summary.csv
```

`ground-mc-reconstructed-links.csv` 会额外输出 `source_plane/source_slot/target_plane/target_slot/tensor_coordinate/tensor_neighbor_count/completion_prior_stack/context_prior_tags/context_prior_risk`，用于确认 INT-MC 的补全样本在卫星平面-槽位张量中的位置和上下文风险。

链路侧当前补全的多指标包括：

```text
utilization_percent
latency_ms
capacity_mbps
congestion_percent
queued_traffic_mb
dropped_traffic_mb
packet_error_rate
```

其中 `queued_traffic_mb`、`dropped_traffic_mb` 和 `packet_error_rate` 更贴近网络遥测与后续 ML 预测任务：它们分别对应链路排队压力、业务丢弃风险和物理/链路层误包风险。重构结果还会附加 `business_hotspot_score`、`route_task_count` 和 `route_traffic_mbps`，用于表达业务热点沿路由路径扩散的先验标签；这些标签来自路由路径与业务量，不直接使用隐藏链路状态真值填补遥测。

节点补全输出：

```text
ground-mc-reconstructed-nodes.csv
int-mc-node-errors.csv
int-mc-node-matrix-summary.csv
```

`ground-mc-reconstructed-nodes.csv` 会额外输出 `tensor_plane/tensor_slot/tensor_coordinate/tensor_neighbor_count/completion_prior_stack/context_prior_tags/context_prior_risk`，用于对齐原生全网 INT 和 INT-MC 在节点状态重构上的比较口径。

真值只在最终评估中使用，不参与 Ground OAM 的过程视角。

## 9. 推荐命令

生成原生全网感知 INT：

```powershell
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/native-probe-int --orbit tle-sgp4 --mode operational --algorithm path-balance
```

生成卫星化 INT-MC：

```powershell
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/leo-int-mc --orbit tle-sgp4 --mode operational --algorithm int-mc --int-mc-sampling-rate 0.25 --int-mc-target-active-link-sampling-rate 0.35
```

切换采样策略：

```powershell
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/leo-int-mc-topology-aware --orbit tle-sgp4 --mode operational --algorithm int-mc --int-mc-selection-strategy topology-aware
```

生成轨道预测采样基线：

```powershell
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/leo-int-mc-orbit-predicted --orbit tle-sgp4 --mode operational --algorithm int-mc --int-mc-selection-strategy orbit-predicted
```

执行 INT-MC 对齐审计：

```powershell
npm run int:align -- --run stage2-int/runs/leo-int-mc
```

## 10. 当前边界

当前实现属于算法级和遥测记录级改造，还不是 P4/Tofino/ns-3 逐包仿真。它适合用于比较：

- 原生全网 `probe-int`；
- `traffic-int` 自然业务路径观测；
- 固定采样 INT-MC；
- 随机采样 INT-MC；
- shortest-path INT-MC；
- topology-aware INT-MC；
- orbit-predicted INT-MC；
- full-int 高开销上限；
- 带自适应拓扑复用的 LEO-INT-MC；
- 有无空间先验矩阵补全；
- 有无 Ground OAM stale-carryover；
- 有无能耗约束和低电量降频。
