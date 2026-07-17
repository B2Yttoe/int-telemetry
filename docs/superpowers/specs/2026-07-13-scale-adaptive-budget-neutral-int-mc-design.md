# 规模自适应、预算中性的 LEO INT-MC 设计

## 1. 目标

解决固定 `maxPathsPerSlice=12` 在中大型星座中的采样稀释，并保证原生 INT-MC 与增强 LEO-INT-MC 使用同一套、同一数值的逐时间片遥测总预算。在该共享预算内，增强方案通过高信息量路径替换、严格选择性 metadata 和轨道面代表节点轮换提高重构质量，不再通过追加路径偿还 AoI 债务。

## 2. 设计边界

- 第一阶段仍是黑盒，不修改轨道、链路、业务、能耗和真值生成。
- 预算规划只使用当前可预测拓扑、静态轨道编号、候选路径、滞后 Ground OAM 和已知业务路由。
- 当前时间片隐藏 CPU、队列、电量、利用率和真值误差不得进入预算、选路或替换决策。
- 不允许按 `Iridium`、`Telesat`、`Starlink` 名称写分支。
- 原生与增强方案共享相同逐片字节预算和相同安全路径上限。
- 增强方案允许使用少于预算的字节，但不得突破共享预算。
- 最大 AoI 不可实现时必须输出 `coverage-infeasible`，不得通过无界增加 probe 假装满足。

## 3. 方案选择

### 3.1 未采用：按节点数公式直接放大路径上限

例如 `K=12*sqrt(N/351)` 实现简单，但忽略路径长度、轨道面覆盖、活动链路数量和候选路径重叠，参数缺少可解释性。

### 3.2 未采用：只由 OAM 不确定性调节采样率

这种方法适合稳定运行后的反馈控制，但冷启动阶段没有可靠 OAM，且容易在历史欠采样时继续低估需求。

### 3.3 采用：覆盖需求推导的共享字节预算

把 `samplingRate` 重新解释为目标节点直接覆盖率，把 `targetActiveLinkSamplingRate` 解释为目标活动链路直接覆盖率。对每个时间片，使用候选 probe 路径执行一次确定性的轻量贪心覆盖估计：

\[
N_t^{target}=\left\lceil\rho_V|V_t|\right\rceil,
\qquad
E_t^{target}=\left\lceil\rho_E|E_t^{active}|\right\rceil
\]

候选路径对节点的覆盖是路径节点集合，对链路的标准覆盖是路径节点能够上报的活动本地端口集合。每一步选择单位标准遥测字节带来最多新增节点/链路覆盖的路径，直到达到两个目标或候选耗尽。

覆盖见证路径集合记为 `W_t`。共享预算为：

\[
B_t=\left\lceil(1+\epsilon)\sum_{p\in W_t}C_{standard}(p)\right\rceil
\]

其中 `epsilon=0.10`，`C_standard` 使用相同的 probe 头、完整标准 hop metadata 和 report 头估计，因此不偏袒增强方案。共享安全路径上限为：

\[
K_t^{safe}=min\left(|P_t^{candidate}|,
\max(K_{legacy},\lceil1.25|W_t|\rceil)\right)
\]

旧 `12` 条限制只作为最低安全容量参考，不再是大型星座硬上界。若用户显式配置更小的硬字节预算，则显式预算优先。

## 4. 原生 INT-MC 行为

原生方案继续使用低秩 leverage、链路新颖性和成本评分，不使用重要性目标、轨道面轮换或选择性字段。改变仅包括：

1. 使用共享 `B_t` 和 `K_t^{safe}`；
2. 在共享预算内选择路径；
3. runner 按逐片预算执行前缀准入，防止估计误差导致实际生成字节超限；
4. 输出预算需求、可行性和实际利用率。

因此它仍是原生 INT-MC 技术路径，只消除了固定绝对路径上限造成的不公平欠采样。

## 5. 增强 LEO-INT-MC 行为

### 5.1 预算内替换

基础路径选择完成后不再追加 `P_t^{repair}`。对重要性候选路径 `q`，在当前集合中寻找最低价值且非强制的路径 `p`。仅当以下条件同时满足时替换：

\[
C(S_t-\{p\}+\{q\})\le B_t
\]

\[
U(q)-U(p)>0
\]

\[
MandatoryCoverage(S_t-\{p\}+\{q\})
=MandatoryCoverage(S_t)
\]

`U` 综合未覆盖重要对象、AoI 债务、临界度、轨道面代表性、低秩信息量和单位字节收益。每条基础路径最多被替换一次，路径总数不得增加。

### 5.2 严格 forward-only

增强方案的 metadata 规则改为：

- 重要节点写 `node-full`；
- 重要链路写 `link-full` 或被明确点名的本地 `link-core`；
- 轨道面轮换代表节点写 `node-core`；
- 不属于上述集合的纯中继节点和非目标链路写 `forward-only`，仍正常转发 probe；
- 不再为所有首次经过节点保留 `node-core`，也不再默认采集首次经过的非目标链路。

### 5.3 轨道面代表节点轮换

节点按 `plane_id` 分组，每个时间片在各轨道面中确定性选择代表 slot：

\[
slot_{p,t}=(t+offset_p)\bmod |S_p|
\]

优先选择 AoI 更高、置信度更低的相邻候选；若预算不足，则按轨道面轮转游标选择本片需要代表的平面，保证长期公平而不是始终测业务热点。代表节点成为显式 `exploration` 目标，因而会写 `node-core`。

## 6. AoI 可行性

根据覆盖见证估计每片最大新增对象数 `c_t`，计算理论可行下界：

\[
H_t^{feasible}=\left\lceil
\frac{|V_t|+|E_t^{eligible}|}{\max(c_t,1)}
\right\rceil
\]

当配置 AoI 上限低于该下界时，输出：

- `aoi_configured_bound_slices`；
- `aoi_feasible_bound_slices`；
- `coverage_feasibility=coverage-infeasible`；
- `coverage_shortfall_nodes/links`。

系统仍优先刷新关键对象，但不会为了满足不可行门限突破总字节预算。

## 7. 产物字段

每片 `probe-summary-int-mc.csv` 新增：

- `scale_budget_enabled`
- `scale_budget_target_nodes`
- `scale_budget_target_active_links`
- `scale_budget_witness_paths`
- `scale_budget_bytes`
- `scale_budget_safe_path_cap`
- `scale_budget_node_coverage_feasible`
- `scale_budget_link_coverage_feasible`
- `importance_budget_replacements`
- `importance_replacement_bytes_before/after`
- `orbit_plane_representative_targets`
- `strict_forward_only_paths/hops`
- `coverage_feasibility`
- `aoi_feasible_bound_slices`

路径 CSV 新增本片角色：`planning_importance_budget_replacement`，旧 `planning_importance_additive_repair` 在新模式中固定为 `false`。

## 8. 验收标准

### 功能验收

- 节点规模增加时，目标覆盖对象数和共享预算单调不减；候选路径覆盖能力提高时所需路径数不增。
- 原生和增强在同一时间片输出完全相同的 `scale_budget_bytes` 与 `scale_budget_safe_path_cap`。
- 增强路径数不超过基础路径数，replacement 后估计和 runner 实际字节均不超过共享预算。
- 非目标纯中继 hop 的 metadata 字节为 0，且仍有 forwarding event。
- 轨道面代表节点在连续时间片轮换，不依赖星座名称。
- 所有规划反馈满足 `source_slice_index < target_slice_index`。

### 短回放门禁

- 先运行 8 片 Iridium 与 12 片 Telesat；不得出现字节预算违规。
- 增强方案相对共享预算原生基线的全局 MAE 退化不超过 1%，分类准确率下降不超过 0.5 个百分点。
- `forward-only` hop 占比必须高于旧 48 片 Starlink 的 `151/23757`。

### 48 时间片中大型回放

- Telesat 351 和 Starlink 1584 使用同一预算推导规则；
- 报告实际字节、直接覆盖、MAE、关键 MAE、异常样本支持、AoI p95/max、可行 AoI 下界和预算利用率；
- 论文结论以 Pareto 非劣和条件优势表述，不要求所有指标绝对全面胜出。
