# INT-Temerity 实验复现与收尾指南

本文档用于项目收尾阶段，目标是让新的使用者能够从当前代码库出发，独立复现以下完整链路：

```text
外部业务数据集
-> 输入数据集校验
-> 第一阶段高仿真卫星星座真值快照
-> 第二阶段 INT / probe-int 全网遥测
-> Ground OAM 重构全网节点和链路状态
-> INT 全网状态交付清单
-> 准确率报告
-> 总体验收报告
```

当前项目已经提供一键总体验收入口：

```bash
npm run verify:goal
```

该命令是收尾阶段最重要的复现命令。它会自动运行第一阶段验收、外部业务数据集端到端 INT 实验、INT 结果复验和前端构建，并在 `reports/goal/` 下生成项目总体验收报告。

## 1. 当前项目完成状态

当前项目已经实现：

- 第一阶段 Walker-Star / TLE-SGP4 风格 LEO 卫星网络仿真底座。
- 节点状态、链路状态、业务路由、能耗、链路预算、天线约束和星地回传窗口建模。
- 外部 CSV/JSON 业务数据集输入和校验。
- traffic-int 业务路径随路遥测。
- probe-int 全网主动遥测。
- reporting path 规划。
- Ground OAM 基于已下传 INT reports 重构节点和链路状态。
- 第一阶段真值只用于实验结束后的准确率检验。
- INT 全网状态交付清单。
- INT 全网感知准确率报告。
- 总体验收脚本和总体验收报告。
- 网页端离线 manifest 导入查看。

当前最新总体验收报告位于：

```text
reports/goal/goal-e2e-verification.json
reports/goal/goal-e2e-verification.md
```

当前验收结论：

```text
pass = true
checks = 19
passed = 19
failed = 0
stage1_score = 100 / 100
int_verification_checks = 80
probe_node_coverage = 1
probe_link_coverage = 1
probe_full_time_step_pass = true
```

这说明当前代码库已经满足项目大目标：输入外部业务数据集后，能够通过 INT 遥测得到全网感知状态数据，并生成该状态数据的准确率检验报告。

## 2. 环境准备

### 2.1 安装依赖

在项目根目录执行：

```bash
npm install
```

如果使用 Windows PowerShell，并且遇到 `npm.ps1` 执行策略问题，可以改用：

```powershell
npm.cmd install
```

### 2.2 推荐运行位置

所有命令都建议在项目根目录执行：

```text
E:\INT-Temerity
```

可以用下面命令确认当前目录：

```powershell
pwd
```

### 2.3 常用脚本总览

```text
npm run dev              启动网页端仪表盘
npm run build            构建前端生产版本
npm run verify:stage1    第一阶段模型总体验收
npm run validate:dataset 校验外部业务数据集
npm run int:experiment   运行第二阶段 INT 端到端实验
npm run int:verify       复验某个 INT 实验 run
npm run verify:goal      运行项目最终总体验收
```

## 3. 最短复现路径

如果只想验证项目是否完整工作，直接运行：

```bash
npm run verify:goal
```

该命令会自动完成：

1. 运行 `scripts/verifyStageOne.mjs`，检查第一阶段仿真底座。
2. 使用 `examples/datasets/stage1-standard-traffic.csv` 作为外部业务输入。
3. 运行 `stage2-int/tools/run-int-experiment.mjs`，生成一次端到端 INT 实验。
4. 运行 `stage2-int/tools/verify-int-experiment.mjs`，复验该实验。
5. 运行 `npm run build`，确认前端可构建。
6. 生成 `reports/goal/goal-e2e-verification.json`。
7. 生成 `reports/goal/goal-e2e-verification.md`。

如果该命令成功结束，终端会输出类似：

```json
{
  "schema_version": "int-temerity-goal-e2e-verification-v1",
  "summary": {
    "pass": true,
    "checks": 19,
    "passed": 19,
    "failed": 0,
    "stage1_score": 100,
    "int_verification_checks": 80,
    "probe_node_coverage": 1,
    "probe_link_coverage": 1,
    "probe_full_time_step_pass": true
  }
}
```

这就是本项目当前最高层级的收尾验收证据。

## 4. 总体验收报告怎么看

运行 `npm run verify:goal` 后，查看：

```text
reports/goal/goal-e2e-verification.md
reports/goal/goal-e2e-verification.json
```

其中 `goal-e2e-verification.json` 是机器可读报告，`goal-e2e-verification.md` 是人类可读报告。

关键字段：

| 字段 | 含义 | 通过标准 |
|---|---|---|
| `summary.pass` | 总体验收是否通过 | `true` |
| `summary.checks` | 总检查项数量 | 当前为 `19` |
| `summary.passed` | 通过检查项数量 | 等于 `checks` |
| `summary.failed` | 失败检查项数量 | `0` |
| `summary.stage1_score` | 第一阶段仿真模型评分 | 当前为 `100` |
| `summary.int_verification_checks` | INT 实验复验检查项数量 | 当前为 `80` |
| `summary.probe_node_coverage` | probe-int 节点覆盖率 | `1` |
| `summary.probe_link_coverage` | probe-int 链路覆盖率 | `1` |
| `summary.probe_full_time_step_pass` | 每个时间步是否都全覆盖 | `true` |

`artifacts` 字段会记录所有关键产物路径：

| artifact | 含义 |
|---|---|
| `manifest_json` | 本次 INT 实验总清单 |
| `input_validation_json` | 输入业务数据集校验报告 |
| `deliverables_json` | INT 全网状态交付清单 |
| `accuracy_report_json` | INT 全网感知准确率报告 |
| `int_verification_json` | 第二阶段 INT 实验复验报告 |
| `file_index_json` | 文件完整性索引 |
| `node_state_csv` | INT 遥测重构出的节点状态 |
| `link_state_csv` | INT 遥测重构出的链路状态 |

## 5. 第一阶段单独复现

第一阶段是高仿真卫星星座模型，也就是第二阶段 INT 的真值底座。单独复现第一阶段：

```bash
npm run verify:stage1
```

该命令会检查：

- 前端构建。
- 场景模板导出。
- 仪表盘审计。
- 标准 CSV/JSON 上传数据集。
- 第一阶段成熟度评估。
- 标准业务响应追踪。
- 第一阶段冻结清单。
- 真值导出审计。

通过后会生成：

```text
reports/stage1/stage1-verification.json
reports/stage1/stage1-verification.md
```

当前总体验收中，第一阶段得分应为：

```text
score = 100 / 100
config_fingerprint = 736dacc2
```

第一阶段真值导出也可以单独运行：

```bash
npm run export:scenario -- --profile normal --orbit tle-sgp4 --mode operational --out exports/normal-tle
```

使用外部业务数据集导出第一阶段真值：

```bash
npm run export:scenario -- --tasks examples/datasets/stage1-standard-traffic.csv --orbit tle-sgp4 --mode operational --out exports/uploaded-standard
```

导出结果包括：

```text
metadata.json
nodes.csv
links.csv
routes.csv
metrics.csv
```

这些文件是全知真值层，第二阶段运行时不读取它们来补齐遥测结果，只在实验结束后用于准确率评估。

## 6. 外部业务数据集复现

### 6.1 标准样例数据集

项目自带标准外部业务数据集：

```text
examples/datasets/stage1-standard-traffic.csv
examples/datasets/stage1-standard-traffic.json
```

标准 CSV 表头：

```csv
task_id,time,start_slice,duration_slices,source,target,node_id,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type
```

其中：

| 字段 | 含义 |
|---|---|
| `task_id` | 任务编号 |
| `start_slice` | 任务开始时间片 |
| `duration_slices` | 持续时间片数量 |
| `source` | 路由任务源卫星 |
| `target` | 路由任务目的卫星 |
| `node_id` | 本地计算任务所在卫星 |
| `compute_units` | 计算负载 |
| `gpu_units` | GPU 负载 |
| `memory_gb` | 内存需求 |
| `storage_gb` | 存储需求 |
| `traffic_mbps` | 业务流量 |
| `priority` | 优先级 |
| `task_type` | 任务类型 |

### 6.2 校验业务数据集

在投入仿真前先运行：

```bash
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv
```

如果需要 JSON 输出：

```bash
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv --json
```

通过标准：

```text
Errors = 0
```

当前标准样例数据集校验摘要为：

```text
accepted tasks = 10
routed tasks = 9
local tasks = 1
total traffic = 3830 Mbps
total compute units = 266
```

### 6.3 自定义数据集要求

自定义数据集可以是 CSV 或 JSON。

路由任务必须提供：

```text
source
target
traffic_mbps
```

本地计算任务必须提供：

```text
node_id
compute_units
```

同一条任务不要同时填写 `source/target` 和 `node_id`，否则端点定义会不明确。

常见合法节点编号：

```text
P01-S01
P02-S04
P08-S08
```

当前默认星座为 8 个轨道面，每个轨道面 8 颗卫星，因此节点编号范围是：

```text
P01-S01 ... P08-S08
```

## 7. 第二阶段 INT 实验复现

### 7.1 运行端到端 INT 实验

使用标准外部业务数据集运行：

```bash
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/reproduce-standard --orbit tle-sgp4 --mode operational --algorithm path-balance
```

该命令会自动完成：

1. 复制业务数据集到 run 目录的 `input/`。
2. 生成输入数据集校验报告。
3. 调用第一阶段黑盒导出真值快照。
4. 运行 traffic-int 业务路径遥测。
5. 生成 probe-int 全网主动探测路径。
6. 规划 reporting path。
7. 模拟 INT reports 下传。
8. Ground OAM 重构节点和链路状态。
9. 生成全覆盖审计。
10. 生成交付清单。
11. 生成准确率报告。
12. 自动运行 INT 复验。

### 7.2 复验某个 INT run

```bash
npm run int:verify -- --run stage2-int/runs/reproduce-standard
```

通过时应看到：

```text
summary.pass = true
summary.failed = 0
probe_node_coverage = 1
probe_link_coverage = 1
probe_full_time_step_pass = true
```

当前标准验收中，INT 复验检查项数量为：

```text
checks = 80
```

如果未来增加新产物或新约束，检查项数量可能会增加，这是正常的；关键是 `pass=true` 且 `failed=0`。

## 8. INT run 目录结构

每次 `int:experiment` 会生成一个 run 目录，例如：

```text
stage2-int/runs/reproduce-standard/
```

典型结构：

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
    probe-paths-path-balance.csv
    reporting-paths-path-balance.csv
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

## 9. 关键产物解释

### 9.1 `input-dataset-validation.json`

输入数据集校验报告。

用于回答：

- 这次实验到底使用了哪份业务输入？
- 原始路径是什么？
- 快照路径是什么？
- 任务数量是多少？
- 有多少路由任务和本地任务？
- 总流量和总计算负载是多少？
- raw dataset 和 stage1 dataset fingerprint 是否一致？
- 是否存在 errors 或 warnings？

通过标准：

```text
status.pass = true
status.raw_dataset_errors = 0
status.stage1_effective_errors = 0
```

### 9.2 `int-telemetry-deliverables.json`

最终交付数据集清单。

最重要的两个字段：

```text
primary_int_state_dataset.node_state_csv
primary_int_state_dataset.link_state_csv
```

它们指向由 INT / probe-int / Ground OAM 重构得到的全网状态数据：

```text
stage2-int/ground-probe-path-balance/ground-reconstructed-nodes.csv
stage2-int/ground-probe-path-balance/ground-reconstructed-links.csv
```

注意：这些是第二阶段从遥测报告重构出的结果，不是第一阶段直接导出的真值表。

### 9.3 `int-telemetry-accuracy-report.json`

准确率报告。

用于回答：

- INT 重构出的节点状态覆盖率是多少？
- INT 重构出的链路状态覆盖率是多少？
- 活动链路覆盖率是多少？
- 是否每个时间片都完成全网覆盖？
- unknown 样本是否为 0？
- 节点模式和链路状态是否匹配真值？

当前标准通过指标：

```text
conclusion.pass = true
primary_probe_int.metrics.node_sample_coverage = 1
primary_probe_int.metrics.link_sample_coverage = 1
primary_probe_int.metrics.active_link_sample_coverage = 1
primary_probe_int.metrics.unknown_node_samples = 0
primary_probe_int.metrics.unknown_link_samples = 0
primary_probe_int.metrics.full_time_step_pass = true
```

### 9.4 `int-experiment-verification.json`

第二阶段 INT run 的复验报告。

它会检查：

- manifest schema。
- 输入校验报告。
- 交付清单。
- 准确率报告。
- 第一阶段真值 CSV 行数。
- INT hop records / reports 行数。
- Ground OAM 边界。
- probe-int 全网覆盖率。
- unknown 样本。
- full coverage audit。
- 文件完整性索引。

当前标准复验结果：

```text
summary.pass = true
summary.checks = 80
summary.failed = 0
```

### 9.5 `int-experiment-file-index.json`

文件完整性索引。

它记录关键产物的：

- role
- path
- relative_path
- size_bytes
- sha256

复制或归档 run 目录后，可以用该文件确认关键实验产物是否缺失或被替换。

## 10. 网页端复现实验结果

### 10.1 启动仪表盘

```bash
npm run dev
```

Vite 会输出类似：

```text
http://127.0.0.1:5173/
```

如果 5173 被占用，会自动切换到 5174、5175 等端口。

### 10.2 导入离线 INT 实验结果

操作步骤：

1. 打开网页端。
2. 点击右上角或导航中的 `遥测仿真`。
3. 找到 `离线 INT 实验结果导入` 面板。
4. 选择某个 run 目录下的：

```text
int-experiment-manifest.json
```

导入后页面会显示：

- 输入业务数据集快照。
- 轨道模式、运行模式、INT 算法。
- traffic-int / probe-int 报告数量。
- path-balance 覆盖率。
- 逐时间片审计。
- 第一阶段 truth fingerprint。
- 边界约束。
- 验收状态。
- 输入校验报告路径。
- 交付清单路径。
- 准确率报告路径。
- 文件索引路径。

### 10.3 网页端应看到的关键结果

标准样例数据集下，应看到：

```text
实验验收：通过
检查项：80 / 80
Path-balance 覆盖：100.0%
逐时间片审计：24/24
probe-int 节点覆盖：100.0%
probe-int 链路覆盖：100.0%
unknown 节点：0
unknown 链路：0
```

## 11. 自定义业务数据集完整复现流程

假设自定义数据集路径为：

```text
data/my-traffic.csv
```

### 11.1 校验数据集

```bash
npm run validate:dataset -- --tasks data/my-traffic.csv
```

必须确保：

```text
Errors = 0
```

### 11.2 运行 INT 实验

```bash
npm run int:experiment -- --tasks data/my-traffic.csv --out stage2-int/runs/my-traffic-int --orbit tle-sgp4 --mode operational --algorithm path-balance
```

### 11.3 复验 INT 实验

```bash
npm run int:verify -- --run stage2-int/runs/my-traffic-int
```

### 11.4 查看最终交付数据

打开：

```text
stage2-int/runs/my-traffic-int/int-telemetry-deliverables.json
```

找到：

```text
primary_int_state_dataset.node_state_csv
primary_int_state_dataset.link_state_csv
```

这两个文件就是该业务数据集下由 INT 遥测得到的全网感知状态数据。

### 11.5 查看准确率报告

打开：

```text
stage2-int/runs/my-traffic-int/int-telemetry-accuracy-report.json
stage2-int/runs/my-traffic-int/int-telemetry-accuracy-report.md
```

重点看：

```text
conclusion.pass
primary_probe_int.metrics.node_sample_coverage
primary_probe_int.metrics.link_sample_coverage
primary_probe_int.metrics.full_time_step_pass
```

### 11.6 网页端查看

启动网页：

```bash
npm run dev
```

导入：

```text
stage2-int/runs/my-traffic-int/int-experiment-manifest.json
```

## 12. 当前验证边界

当前项目已经完成研究闭环，但仍有明确边界：

- 当前 TLE + SGP4 使用 synthetic-walker 风格合成 TLE，不是 CelesTrak / Space-Track 真实公开 TLE 数据源。
- 当前目标是 Walker LEO 网络和 INT 遥测机制复现，不是完整通信链路级仿真器。
- traffic-int 保留业务路径局部观测特征，不要求覆盖全网。
- 全网状态感知由 probe-int 主动探测实现。
- 准确率检验使用第一阶段真值，但运行时不使用真值补齐 unknown。
- 当前路由算法以最短路径为主，未实现负载感知、多路径、能量感知等高级路由切换。
- 当前协议层没有实现 TCP/QUIC、逐包重传、完整 MAC 退避或 FEC 编译码过程。

这些边界不会影响当前总体验收目标，但应在论文、汇报和后续扩展计划中说明。

## 13. 常见问题

### 13.1 `npm run verify:goal` 很慢怎么办？

它会运行第一阶段完整验收、二阶段 INT 实验、INT 复验和前端构建，因此比单独 `int:verify` 慢。收尾验收时推荐完整运行；日常调试可以只运行：

```bash
npm run int:verify -- --run <run-dir>
```

### 13.2 为什么 traffic-int 覆盖率不是 100%？

traffic-int 是业务流随路遥测，只观测业务路径经过的节点和链路，所以它应该是局部覆盖。当前标准样例中 traffic-int 节点覆盖约 22.27%，链路覆盖约 11.01%，这是合理的。

全网状态感知由 probe-int 完成，验收标准是 probe-int 节点和链路覆盖率均为 100%。

### 13.3 为什么准确率 MAE 是 0？

当前 probe-int 采集的是模型时间片中的状态字段，并通过 Ground OAM 重构；在标准样例和足够下传预算下，所有节点和链路样本均被观测到，因此 CPU、队列、电量等字段与真值对照误差为 0。后续如果加入采样率限制、下传预算不足、报告丢失或噪声模型，MAE 可能不再为 0。

### 13.4 可以跳过第一阶段验收吗？

总体验收脚本支持：

```bash
node scripts/verifyEndToEndGoal.mjs --skip-stage1
```

但收尾阶段不建议跳过。正式报告、论文实验或答辩演示前应运行完整：

```bash
npm run verify:goal
```

### 13.5 可以跳过前端构建吗？

总体验收脚本支持：

```bash
node scripts/verifyEndToEndGoal.mjs --skip-build
```

这只适合命令行环境调试。正式收尾验收建议保留前端构建检查。

### 13.6 Windows 下 `npm.ps1` 不能运行怎么办？

使用 `npm.cmd`：

```powershell
npm.cmd run verify:goal
npm.cmd run dev
npm.cmd run build
```

## 14. 收尾归档建议

建议保留以下内容作为最终交付证据：

```text
reports/goal/goal-e2e-verification.json
reports/goal/goal-e2e-verification.md
reports/stage1/stage1-verification.json
reports/stage1/stage1-verification.md
stage2-int/runs/<final-run>/README.md
stage2-int/runs/<final-run>/int-experiment-manifest.json
stage2-int/runs/<final-run>/input-dataset-validation.json
stage2-int/runs/<final-run>/int-telemetry-deliverables.json
stage2-int/runs/<final-run>/int-telemetry-accuracy-report.json
stage2-int/runs/<final-run>/int-experiment-verification.json
stage2-int/runs/<final-run>/int-experiment-file-index.json
stage2-int/runs/<final-run>/stage2-int/ground-probe-path-balance/ground-reconstructed-nodes.csv
stage2-int/runs/<final-run>/stage2-int/ground-probe-path-balance/ground-reconstructed-links.csv
```

建议在最终汇报中固定记录：

```text
config_fingerprint
dataset_fingerprint
truth_fingerprint
run_dir
node_state_csv
link_state_csv
accuracy_report_json
goal-e2e-verification.json
```

这样后续即使重新运行实验，也能明确区分不同配置、不同业务数据集和不同真值快照。

## 15. 收尾检查清单

正式收尾前，逐项确认：

- `npm install` 已成功。
- `npm run verify:goal` 通过。
- `reports/goal/goal-e2e-verification.json` 中 `summary.pass=true`。
- `stage1_score=100`。
- `int_verification_checks >= 80` 且 `failed=0`。
- `probe_node_coverage=1`。
- `probe_link_coverage=1`。
- `probe_full_time_step_pass=true`。
- `int-telemetry-deliverables.json` 指向的节点和链路 CSV 存在。
- `int-telemetry-accuracy-report.json` 中 `conclusion.pass=true`。
- 网页端可以导入 `int-experiment-manifest.json`。
- README、使用指南和本文档中的命令与当前脚本一致。

完成以上检查后，可以认为当前项目进入收尾封版状态。
