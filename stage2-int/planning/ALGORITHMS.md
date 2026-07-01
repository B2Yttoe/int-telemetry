# INT Path Planning Algorithms

本目录后续实现 Zhang 等 2024 论文中的网络级 INT path planning。

## 1. traffic-int MVP

输入：

- 第一阶段 `routes.csv`

过程：

1. 筛选 `status = routed` 的业务任务。
2. 按采样策略选择任务。
3. 沿 `path` 逐跳生成 INT hop record。
4. source 节点写入 INT instruction。
5. transit 节点追加本地 telemetry metadata。
6. sink 节点生成 INT report。

优点：

- 实现简单。
- 能验证 INT 非全知原则。

缺点：

- 覆盖率依赖业务流量分布。
- 无业务经过的链路无法被观测。

## 2. probe-int Path-original

输入：

- 当前时间片 topology graph `G(V,E)`。

目标：

- 找到路径集合 `P`，覆盖所有 active ISL。
- 路径数量尽量少。
- 链路重复覆盖尽量少。

论文思路：

1. 如果奇度点数量 `odd_num <= 2`，使用 Hierholzer 算法得到 Euler path/circuit。
2. 如果 `odd_num > 2`：
   - 拆分拓扑为 intra-orbit circuits `C`。
   - 拆分 active inter-orbit ISL 为 segments `S`。
   - 从 `S` 中选择若干段与 `C` 拼接。
   - 剩余 segments 自身构成探测路径。

输出：

- `probe-paths.csv`

当前实现：

- 工具：`tools/probe-path-planner.mjs`
- 命令：

```bash
node stage2-int/tools/probe-path-planner.mjs --input exports/tmp-highload-check --out stage2-int/outputs/tmp-highload-check --algorithm path-original
```

实现说明：

- 每个时间片读取 active ISL。
- 按链路类型拆分为 intra-orbit circuits 和 inter-orbit segments。
- 使用 Euler trail 分解保证 active link 被覆盖。
- 输出 `probe-paths-path-original.csv`、`probe-summary-path-original.csv`、`probe-coverage-path-original.json`。

## 3. probe-int Path-balance

目标：

- 在 Path-original 的基础上平衡路径长度。

论文思路：

1. 将 inter-orbit segments 按长度排序。
2. 优先把较短 segments 与 intra-orbit circuits 拼接。
3. 降低 path length STD 和 longest path length。

评估：

- telemetry time
- path length STD
- longest path length
- duplicate link collection count

当前实现：

- 工具：`tools/probe-path-planner.mjs`
- 命令：

```bash
node stage2-int/tools/probe-path-planner.mjs --input exports/tmp-highload-check --out stage2-int/outputs/tmp-highload-check --algorithm path-balance
```

实现说明：

- 在 Path-original 的拓扑拆分基础上，对 inter-orbit segments 按长度升序处理。
- 优先把较短 segment 与 intra-orbit circuit 拼接。
- 输出 Path-balance 的覆盖率、最长路径和路径长度标准差。

## 4. Probe INT Runner

输入：

- `probe-paths-path-balance.csv`
- `reporting-paths-path-balance.csv`
- 第一阶段 `nodes.csv` 和 `links.csv`

过程：

1. source 节点按规划路径发起 probe INT 包。
2. 每个 transit 节点追加本机状态、队列状态、能量状态等节点遥测字段。
3. 每个被 probe 经过的卫星默认执行 `all-adjacent` 本地链路扫描，上报相邻候选链路的状态。
4. 因此 active 链路通过转发路径被观测，inactive/blocked 链路通过端点卫星的本地端口状态被观测。
5. INT sink 生成 report，并携带 reporting path 元数据。

工具：

```bash
node stage2-int/tools/probe-int-runner.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --algorithm path-balance
```

输出：

```text
probe-int-hop-records-path-balance.csv
probe-int-reports-path-balance.csv
probe-int-run-report-path-balance.json
```

这一层把“路径规划结果”转化为真正可由 ground OAM 消费的 INT 遥测报告，是实现逐时间步全网状态捕获的关键。

## 5. Reporting Path

输入：

- INT sink 节点。
- 当前可用 direct-linked satellite。
- 当前 active ISL 图。

过程：

1. 按 ground window / elevation 选择 direct-linked satellite。
2. 使用 Dijkstra 计算 `INT sink -> direct-linked satellite` 最短路径。
3. report 经 direct-linked satellite 下传到 ground OAM。

输出：

- `reporting-paths.csv`
- `int-reports.csv`

当前实现：

- 工具：`tools/reporting-path-planner.mjs`
- 命令：

```bash
node stage2-int/tools/reporting-path-planner.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --algorithm path-balance
```

实现说明：

- 使用 `active_sgl_links > 0` 的卫星作为 direct-linked satellite 候选。
- 在当前 active ISL 图上用 Dijkstra 计算 `INT sink -> direct-linked satellite` 最短路径。
- 输出 `reporting-paths-path-balance.csv`、`reporting-summary-path-balance.csv`、`reporting-coverage-path-balance.json`。

## 5. LEO-INT-MC

`int-mc` 是从 `E:\INT-MC-main\INT-MC-main` 中迁移过来的 INT-MC 思想版，而不是直接搬运 Mininet/P4 原型。原型中的核心思想包括：

- 按路径而不是按单个链路进行采样。
- 用 leverage score 选择信息量更高的采样位置。
- 用矩阵补全恢复未直接观测的网络状态。

卫星网络适配后的实现位于：

```text
stage2-int/tools/int-mc-path-selector.mjs
stage2-int/tools/int-mc-reconstructor.mjs
```

LEO 动态拓扑下的关键改动：

- 使用 TLE/SGP4 拓扑快照形成 contact plan。
- 将相似时间片归入 topology class，避免每个时间片从零重算。
- 区分 `active_mask` 与 `observed_mask`：物理断链不参与补全，只有物理可用但未观测的链路才补全。
- 使用确定性 warmup 和滑动窗口 stale-link 优先级，替代 Mininet 原型中的随机初始采样。
- 矩阵补全运行在 Ground OAM 侧，卫星端不承担矩阵分解计算。

运行方式：

```powershell
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/int-mc-smoke --orbit tle-sgp4 --mode operational --algorithm int-mc --int-mc-sampling-rate 0.25 --int-mc-rank 5 --int-mc-window 12
```

主要输出：

- `stage2-int/probe-paths-int-mc.csv`：LEO-INT-MC 选择后的低开销 probe path。
- `stage2-int/probe-coverage-int-mc.json`：路径采样、topology class 与 contact plan 摘要。
- `stage2-int/int-mc-contact-plan-int-mc.json`：按时间片组织的 contact plan。
- `stage2-int/ground-probe-int-mc/ground-mc-reconstructed-links.csv`：Ground OAM 侧矩阵补全后的链路状态。
- `stage2-int/ground-probe-int-mc/int-mc-evaluation.json`：补全覆盖率、误差和边界说明。

注意：`int-mc` 的直接 probe 覆盖率不会等于 100%，这是设计目标。它的有效性应看 active link completion、推断误差、遥测开销和 topology-down 边界，而不是看直接观测覆盖率。

## 6. Ground OAM Reconstruction

输入：

- `int-hop-records.csv`
- `int-reports.csv`
- 第一阶段 `nodes.csv` 和 `links.csv`，仅用于评估真值。

过程：

1. 按每时间片 downlink budget 决定哪些 INT reports 成功到达 ground OAM。
2. 只使用成功下传 reports 对应的 hop records。
3. 重构 observed node/link 状态。
4. 未观测对象标记为 `unknown`，confidence 为 0。
5. 评估阶段才读取第一阶段真值，计算覆盖率和误差。

工具：

```bash
node stage2-int/tools/ground-oam-reconstructor.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check
```

低预算压力测试：

```bash
node stage2-int/tools/ground-oam-reconstructor.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --out stage2-int/outputs/tmp-highload-budget-2kb --downlink-budget-bytes 2048 --carry-over false
```

全网逐时间步 probe-int 重构：

```bash
node stage2-int/tools/ground-oam-reconstructor.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --hops stage2-int/outputs/tmp-highload-check/probe-int-hop-records-path-balance.csv --reports stage2-int/outputs/tmp-highload-check/probe-int-reports-path-balance.csv --out stage2-int/outputs/tmp-highload-check/ground-probe-path-balance
```

覆盖审计：

```bash
node stage2-int/tools/audit-full-telemetry-coverage.mjs --input exports/tmp-highload-check --ground stage2-int/outputs/tmp-highload-check/ground-probe-path-balance
```
