# Stage 2 INT Telemetry Design

本文档定义第二阶段 INT 遥测子系统。第一阶段 Walker/LEO 星座模型已经冻结为黑盒真值环境；除非明确要求回到第一阶段代码修改，第二阶段不修改 `src/` 下的第一阶段模型。

## 1. 设计依据

本阶段设计主要来自两类依据：

- Zhang 等，2024，*In-band Network-Wide Telemetry for Topology-Varying LEO Satellite Networks*。论文针对拓扑变化的 LEO 卫星网络提出 INT 网络级遥测方案，核心是利用可预测的拓扑快照规划探测路径，覆盖全网 ISL，并通过 reporting path 把 INT sink 的遥测报告送回地面 OAM。
- 公开 INT/IOAM 基础规范。P4.org INT Dataplane Specification 将 INT 定义为由数据平面采集和报告网络状态的框架，报文可携带 telemetry instructions；RFC 9197/9378 将 IOAM 描述为报文穿越网络时记录运行与遥测信息；RFC 9326 提供 Direct Export 思路，可作为后续直接导出或本地聚合的参考。

## 2. 与第一阶段黑盒的边界

第一阶段模型继续负责：

- 生成每个时间片的卫星节点、链路、路由、星地窗口和全网指标真值。
- 导出 `truth.json`、`nodes.csv`、`links.csv`、`routes.csv`、`metrics.csv` 等真值文件。
- 作为第二阶段评估用的 Ground Truth。

第二阶段 INT 子系统负责：

- 按业务路径或主动 probe path 产生 INT 探测包。
- 逐跳采集路径经过节点和链路的局部状态。
- 经星地链路或离线报告通道回传遥测。
- 在地面 OAM 重构有限观测视角下的网络状态。
- 与第一阶段真值对比覆盖率、开销、时效性和误差。

运行时约束：

- INT 运行模块不能全知读取第一阶段全部节点和链路状态。
- INT 只能读取当前 packet/probe 经过的节点与 ingress/egress 链路。
- 未经过、未采样、未成功回传的节点或链路必须标记为 `unknown`，不能用真值补齐。
- 完整真值只允许 `evaluation/` 模块在实验结束后读取。

## 3. 论文机制到本项目的映射

| 论文概念 | 本项目对应 |
|---|---|
| LEO 拓扑图 `G(V,E)` | 某个 `slice_index` 下的 `nodes.csv` 和 active `links.csv` |
| `v_ij` 卫星节点 | `Pxx-Syy` 节点 ID |
| ISL 边状态 `e_i = 1/0` | `links.csv` 中 `is_active` 和 `status` |
| INT source satellite | 探测路径第一个节点 |
| INT transit satellite | 探测路径中间节点 |
| INT sink satellite | 探测路径最后一个节点，生成 telemetry report |
| probing path set `P` | `probe-paths.csv` |
| reporting path | `INT sink -> direct-linked satellite -> ground OAM` 的最短路径 |
| Path-original | 基于 Euler path / topology decomposition 的原始规划 |
| Path-balance | 按 inter-orbit segment 长度排序后的均衡规划 |
| telemetry time | 一轮网络级遥测完成时间 |
| path length STD | 探测路径长度均衡性 |
| longest path length | 最长探测路径长度 |

## 4. 第二阶段双模式

### 4.1 traffic-int

随业务包遥测。读取第一阶段 `routes.csv` 中 routed 任务路径，INT 记录只沿业务路径生成。

适合验证：

- INT 非全知原则。
- 业务经过区域的节点/链路可观测性。
- INT 观测覆盖率与业务流量分布的关系。

### 4.2 probe-int

论文式网络级主动探测。每个时间片根据 active ISL 构建拓扑图，并规划 probe paths 覆盖全网链路。

适合验证：

- 网络级 ISL 覆盖能力。
- Path-original 与 Path-balance 的开销、均衡性和时效性。
- INT sink 到 ground OAM 的 reporting path。

## 5. 阶段计划

### 2.0 设计冻结

产物：

- `README.md`
- `config/*.json`
- `schemas/*.json`
- `adapters/PORTS.md`
- `planning/ALGORITHMS.md`
- `evaluation/METRICS.md`

目标：固定第二阶段与第一阶段黑盒的端口、字段和评估口径。

### 2.1 traffic-int MVP

产物：

- `tools/offline-int-mvp.mjs`
- `outputs/.../int-hop-records.csv`
- `outputs/.../int-reports.csv`
- `outputs/.../reconstructed-nodes.csv`
- `outputs/.../reconstructed-links.csv`
- `outputs/.../coverage-report.json`

目标：只沿 routed 业务路径逐跳采集局部状态，先证明第二阶段 INT 不再全知读取全网。

### 2.2 probe-int Path-original

目标：对每个拓扑快照构建 `G(V,E)`，实现论文中的 Euler path / topology decomposition 思路，生成覆盖 active ISL 的 probe paths。

### 2.3 probe-int Path-balance

目标：按论文的 balanced algorithm 对 inter-orbit segments 排序并拼接，降低最长路径长度和路径长度标准差。

### 2.4 reporting path

目标：从每个 INT sink 到当前 direct-linked satellite 计算最短 reporting path，并通过 SGL 下传到 ground OAM。

### 2.5 ground reconstruction

目标：地面端只用成功下传的 INT reports 重构节点和链路状态，未观测部分为 `unknown`。

### 2.6 evaluation

目标：实验结束后读取第一阶段真值，计算覆盖率、开销、时效性、均衡性和误差。

## 6. 当前 MVP 使用方式

如果已经有第一阶段导出目录，例如：

```text
exports/tmp-highload-check/
  nodes.csv
  links.csv
  routes.csv
```

可以运行：

```bash
node stage2-int/tools/offline-int-mvp.mjs --input exports/tmp-highload-check --out stage2-int/outputs/tmp-highload-check
```

该命令只做 traffic-int MVP：

- 读取 routed 业务路径。
- 对路径上的 source/transit/sink 节点生成 INT hop records。
- 只访问路径经过节点和路径链路的局部状态。
- 生成有限观测下的重构表和覆盖率报告。

### 6.1 生成论文式网络级 probe paths

基于当前时间片 active ISL 生成 Path-original 和 Path-balance 两组网络级 INT 探测路径：

```bash
node stage2-int/tools/probe-path-planner.mjs --input exports/tmp-highload-check --out stage2-int/outputs/tmp-highload-check --algorithm both
```

输出：

```text
probe-paths-path-original.csv
probe-summary-path-original.csv
probe-coverage-path-original.json
probe-paths-path-balance.csv
probe-summary-path-balance.csv
probe-coverage-path-balance.json
```

当前高负载样例的验证结果：

```text
Path-original:
  probe_count = 192
  link_coverage = 1.000
  max_path_length = 15
  path_length_std = 2.568
  duplicate_probe_link_count = 0

Path-balance:
  probe_count = 192
  link_coverage = 1.000
  max_path_length = 15
  path_length_std = 2.566
  duplicate_probe_link_count = 0
```

这一步对应 Zhang 等 2024 的 monitoring path planning：每个拓扑快照被建模成 `G(V,E)`，探测路径集合覆盖全部 active ISL，并尽量减少重复覆盖。

### 6.2 执行 probe-int 并生成全网遥测报告

路径规划只说明 probe 应该怎么走；真正用于地面 OAM 重构的是沿 probe path 生成的 INT hop records 和 INT reports：

```bash
node stage2-int/tools/probe-int-runner.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --algorithm path-balance
```

输出：

```text
probe-int-hop-records-path-balance.csv
probe-int-reports-path-balance.csv
probe-int-run-report-path-balance.json
```

该工具默认使用 `--link-observation-mode all-adjacent`。含义是：probe 包每经过一颗卫星，除了记录转发路径上的 ingress/egress 链路，还会让该卫星上报本机相邻候选链路的本地端口状态。因此，即使某条轨间链路当前断开、不能承载转发，也可以通过端点卫星的本地链路状态进入遥测报告。

当前高负载样例验证结果：

```text
probe_paths = 192
hop_records = 8440
reports = 192
node_sample_coverage = 1.000
active_link_sample_coverage = 1.000
blocked_reporting_paths = 0
```

### 6.3 生成 reporting paths

基于 Path-balance 的 INT sink，规划到当前可星地下传卫星的最短回传路径：

```bash
node stage2-int/tools/reporting-path-planner.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --algorithm path-balance
```

输出：

```text
reporting-paths-path-balance.csv
reporting-summary-path-balance.csv
reporting-coverage-path-balance.json
```

当前高负载样例的验证结果：

```text
probes = 192
planned_reporting_paths = 192
blocked_reporting_paths = 0
mean_reporting_hops = 2.234
max_reporting_hops = 5
```

这一步对应论文里的 reporting path planning：从 INT sink 到 direct-linked satellite 使用最短路径回传，再通过星地链路送到 ground OAM。当前 MVP 使用 `nodes.csv` 中 `active_sgl_links > 0` 近似表示可直连地面站的卫星。

### 6.4 traffic-int 地面 OAM 重构与真值评估

地面 OAM 只能使用成功下传的 INT reports 重构网络状态：

```bash
node stage2-int/tools/ground-oam-reconstructor.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --out stage2-int/outputs/tmp-highload-check
```

输出：

```text
ground-delivered-reports.csv
ground-undelivered-reports.csv
ground-reconstructed-nodes.csv
ground-reconstructed-links.csv
ground-oam-evaluation.json
```

默认预算验证结果：

```text
generated_reports = 384
delivered_reports = 384
delivered_hop_records = 2290
node_sample_coverage = 0.571
active_link_sample_coverage = 0.4089
cpu_mae = 0
link_utilization_mae = 0
congestion_recall_over_global_truth = 1
```

低预算压力测试：

```bash
node stage2-int/tools/ground-oam-reconstructor.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --out stage2-int/outputs/tmp-highload-budget-2kb --downlink-budget-bytes 2048 --carry-over false
```

低预算验证结果：

```text
generated_reports = 384
delivered_reports = 58
delivered_hop_records = 308
node_sample_coverage = 0.1862
active_link_sample_coverage = 0.0969
congestion_recall_over_global_truth = 0.3209
```

这说明第二阶段地面 OAM 重构已经受回传容量约束：报告未成功到达时，对应节点和链路不会进入 observed 状态，而是保持 unknown。

### 6.5 probe-int 全网逐时间步重构

如果目标是“每一个时间步下捕获全网卫星节点和链路状态”，应使用 probe-int 的报告作为地面 OAM 输入，而不是 traffic-int 的业务流报告：

```bash
node stage2-int/tools/ground-oam-reconstructor.mjs --input exports/tmp-highload-check --stage2 stage2-int/outputs/tmp-highload-check --hops stage2-int/outputs/tmp-highload-check/probe-int-hop-records-path-balance.csv --reports stage2-int/outputs/tmp-highload-check/probe-int-reports-path-balance.csv --out stage2-int/outputs/tmp-highload-check/ground-probe-path-balance
```

验证结果：

```text
generated_reports = 192
delivered_reports = 192
delivered_hop_records = 8440
node_sample_coverage = 1.000
link_sample_coverage = 1.000
active_link_sample_coverage = 1.000
```

其中 `link_sample_coverage = 1.000` 的统计范围是第一阶段 `links.csv` 导出的全部链路行，包括 active 链路和当前断开的候选链路。

逐时间步覆盖审计：

```bash
node stage2-int/tools/audit-full-telemetry-coverage.mjs --input exports/tmp-highload-check --ground stage2-int/outputs/tmp-highload-check/ground-probe-path-balance
```

当前审计结果：

```text
slices = 24
passed_slices = 24
failed_slices = 0
node_sample_coverage = 1.000
link_sample_coverage = 1.000
pass = true
```

### 6.6 一键端到端 INT 实验

外部业务数据集进入项目后，推荐使用一键实验入口。它会自动完成：

1. 调用第一阶段黑盒导出真值快照。
2. 运行 traffic-int 业务随路遥测。
3. 运行 probe-int 全网主动探测。
4. 规划 reporting path。
5. 执行 Ground OAM 重构。
6. 生成准确率/覆盖率报告。

示例：

```bash
npm run int:experiment -- --tasks examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv --out stage2-int/runs/main-8x8-path-balance-smoke --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json --mode operational --algorithm path-balance
```

实验结束后建议立刻运行验收：

```bash
npm run int:verify -- --run stage2-int/runs/main-8x8-path-balance-smoke
```

当前 `int:experiment` 会默认自动运行同一套验收，写出验收报告，并把验收摘要写回 `int-experiment-manifest.json` 的 `verification` 字段；`int:verify` 主要用于之后复验已有 run，或在手工替换某些输出文件后重新检查。调试中如果只想生成实验文件、暂时不跑验收，可以追加 `--skip-verify`。

调试时可以追加 `--slices <N>` 缩短第一阶段真值导出的时间片数量。短时间片烟测适合检查管线是否连通，但如果业务数据集本身覆盖 48 个时间片，被截断的任务会在输入校验报告中体现为 warnings；正式覆盖率和准确率结论应使用完整时间片实验。

如果需要一次性验收整个研究目标，可以运行：

```bash
npm run verify:goal
```

该命令会顺序执行第一阶段验收、Starlink 主壳层 `8x8` Radar 校准业务 INT 端到端实验、INT 复验和前端构建，并在 `reports/goal/` 下生成 `goal-e2e-verification.json` 与 `goal-e2e-verification.md`。它会检查第一阶段仿真底座是否通过、输入业务数据集是否校验通过、INT 是否只基于已下传报告重构、probe-int 是否达到逐时间片全网节点/链路 100% 覆盖、最终交付清单和准确率报告是否存在并互相指向。

完整复现实验步骤、输出解释和收尾归档建议见根目录 [EXPERIMENT_REPRODUCTION_GUIDE.md](../EXPERIMENT_REPRODUCTION_GUIDE.md)。

当使用 `--tasks` 输入外部业务数据集时，脚本会先把该 CSV/JSON 复制到本次 run 的 `input/` 目录，并使用这份快照执行后续仿真。manifest 会同时记录 `original_tasks_path` 和 `tasks_snapshot_path`，避免原始数据集移动或被覆盖后无法复现实验。

每个 run 目录还会生成独立的 `README.md`，说明本次实验的输入、INT 边界约束、核心覆盖率指标、复验命令、网页导入方式和关键输出文件。这样单独归档或移动某个 run 目录时，也能快速确认这次实验做了什么以及如何复验。

每次使用 `--tasks` 输入外部业务数据集时，实验还会生成 `input-dataset-validation.json` 与 `input-dataset-validation.md`。该报告复用 `npm run validate:dataset` 的解析和校验逻辑，记录输入快照、原始路径、任务数量、路由任务/本地任务数量、总流量、总算力需求、数据集指纹以及进入第一阶段仿真后的有效校验结果。若存在 errors，本次实验不应作为有效 INT 遥测实验使用。

同时会生成 `int-telemetry-deliverables.json` 与 `int-telemetry-deliverables.md`，作为本次实验的最终交付数据集清单。它会把 `ground-probe-<algorithm>/ground-reconstructed-nodes.csv` 和 `ground-probe-<algorithm>/ground-reconstructed-links.csv` 标记为“由 INT 遥测得到的全网状态主输出”，并把第一阶段 `stage1-truth/*.csv` 标记为仅用于准确率检验的真值数据。

根目录还会生成 `int-telemetry-accuracy-report.json` 与 `int-telemetry-accuracy-report.md`，集中说明 INT 全网感知状态与第一阶段真值的对照结果，包括 probe-int 节点/链路覆盖率、活动链路覆盖率、unknown 样本数、节点模式准确率、链路状态准确率和逐时间片全覆盖审计。

验收还会生成 `int-experiment-file-index.json` 与 `int-experiment-file-index.md`，记录输入快照、第一阶段真值、INT hop records/reports、OAM 重构、实验报告和验收报告等关键文件的字节数与 SHA-256。复制或归档 run 目录后，可以用这份索引确认实验包没有丢失或被篡改。

验收会检查：

- `README.md`、`input-dataset-validation.json/.md`、`int-telemetry-deliverables.json/.md`、`int-telemetry-accuracy-report.json/.md`、`int-experiment-manifest.json` 与 `int-experiment-report.md` 是否存在。
- 第一阶段 `nodes.csv`、`links.csv`、`routes.csv`、`metrics.csv` 行数是否与 manifest 一致。
- traffic-int / probe-int 的 hop records、reports、probe paths、reporting paths 行数是否与管线统计一致。
- Ground OAM 是否只使用已下传报告，真值是否只用于评估，unknown 是否没有用真值补齐。
- probe-int 是否达到每个时间片的节点和链路全覆盖，`full-telemetry-coverage-audit.json` 是否 24/24 通过。

验收结果会写入：

```text
stage2-int/runs/<run-name>/
  int-experiment-verification.json
  int-experiment-verification.md
```

输出目录结构：

```text
stage2-int/runs/<run-name>/
  README.md
  input-dataset-validation.json
  input-dataset-validation.md
  int-telemetry-deliverables.json
  int-telemetry-deliverables.md
  int-telemetry-accuracy-report.json
  int-telemetry-accuracy-report.md
  int-experiment-manifest.json
  int-experiment-report.md
  int-experiment-verification.json
  int-experiment-verification.md
  int-experiment-file-index.json
  int-experiment-file-index.md
  input/
    <uploaded-task-dataset>.csv
  stage1-truth/
    metadata.json
    nodes.csv
    links.csv
    routes.csv
    metrics.csv
  stage2-int/
    int-hop-records.csv
    int-reports.csv
    probe-int-hop-records-path-balance.csv
    probe-int-reports-path-balance.csv
    ground-traffic-int/
      ground-oam-evaluation.json
      ground-reconstructed-nodes.csv
      ground-reconstructed-links.csv
    ground-probe-path-balance/
      ground-oam-evaluation.json
      full-telemetry-coverage-audit.json
      ground-reconstructed-nodes.csv
      ground-reconstructed-links.csv
```

当前标准外部业务数据集验证结果：

```text
traffic-int:
  node_sample_coverage = 0.2227
  link_sample_coverage = 0.1101
  unknown_node_samples = 1194
  unknown_link_samples = 2563

probe-int:
  node_sample_coverage = 1
  link_sample_coverage = 1
  active_link_sample_coverage = 1
  full_time_step_pass = true
  passed_slices = 24
  failed_slices = 0
```

这说明 traffic-int 保留了业务路径局部观测特性；probe-int 则用于生成每个时间步的全网感知状态数据和准确率报告。

### 6.7 网页端查看离线实验结果

`int:experiment` 生成的 `int-experiment-manifest.json` 可以直接导入网页端：

1. 启动项目网页：`npm run dev`。
2. 打开仪表盘右上角的 `遥测仿真`。
3. 在 `离线 INT 实验结果导入` 面板选择本次实验目录下的 `int-experiment-manifest.json`。

导入后页面会展示：

- 输入业务数据集、轨道模式、运行模式、路由算法和 INT 探测算法。
- 第一阶段 `config/dataset/truth` 指纹，确认遥测结果对应哪一次真值快照。
- traffic-int 与 probe-int 的 reports、hop records、路径规划和 reporting path 统计。
- traffic-int/probe-int 的节点覆盖率、链路覆盖率、活动链路覆盖率、MAE、模式准确率、链路状态准确率和 unknown 样本数。
- manifest 内写回的 `verification` 摘要，包括验收是否通过、检查项数量、验收时间和验收报告路径。
- `stage1_truth_used_for_runtime=false`、`truth_used_only_for_validation=true`、`unknown_not_filled_from_truth=true` 等边界约束。

网页中的实时 `probe-int/traffic-int` 面板仍用于交互式理解遥测过程；正式外部业务数据集实验以导入的离线 manifest 和 `stage2-int/runs/<run-name>/` 下的 CSV/JSON 报告为准。

## 7. MVP 成功标准

- 未被采样的任务不产生 INT 记录。
- 未在路径上的节点不进入 `reconstructed-nodes.csv`。
- 未在路径上的链路不进入 `reconstructed-links.csv`。
- 覆盖率小于等于 1，并且允许 unknown。
- `coverage-report.json` 能清楚说明 INT 看到多少节点、链路和路径。
- `ground-oam-evaluation.json` 能证明地面 OAM 只使用成功下传的 reports，并在预算不足时降低覆盖率。
- 对于全网感知实验，`probe-int + ground OAM + audit-full-telemetry-coverage` 必须证明每个 `slice_index` 的节点样本和链路样本覆盖率均为 1。
