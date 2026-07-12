# INT-Temerity：LEO 卫星网络仿真与 INT 全网遥测实验平台

本项目构建了一个面向 LEO 卫星网络的两阶段实验平台：

1. **第一阶段：卫星网络真值仿真**  
   生成随时间片变化的 Walker-Star / Starlink-like 卫星网络，包括轨道、节点、链路、业务、能耗、链路预算和路由状态。

2. **第二阶段：INT 带内网络遥测复现**  
   在第一阶段生成的动态网络上运行 `traffic-int` 和 `probe-int`，模拟 INT 报文逐跳采集节点与链路状态，并由 Ground OAM 在非全知视角下重构全网状态。

项目当前的定位不是 ns-3 级逐包通信仿真器，而是一个 **中高层次、可解释、可复现实验的 LEO 网络状态生成与 INT 遥测验证平台**。它适合用于：

- 生成每个时间片下的卫星节点状态和链路状态；
- 投喂业务数据集，观察业务对节点负载、链路拥塞和遥测结果的影响；
- 研究 INT 在动态 LEO 网络中的覆盖率、开销、回传能力和重构误差；
- 为后续机器学习预测、INT-MC 矩阵补全或更高级遥测算法提供数据基础。

## 1. 当前根目录结构

```text
INT-Temerity/
  README.md                    当前项目总说明
  index.html                   Vite 前端入口
  package.json                 命令脚本与依赖
  package-lock.json            依赖锁定文件
  tsconfig.json                TypeScript 配置
  tsconfig.node.json           Node/Vite TypeScript 配置
  vite.config.ts               Vite 配置

  src/                         第一阶段仿真模型与前端仪表盘
  stage2-int/                  第二阶段 INT 遥测实验子系统
  scripts/                     数据生成、校验、导出、验收脚本
  examples/                    示例业务数据集
  data/                        真实 TLE/OMM 快照等输入数据
  schemas/                     数据集和配置结构定义
  traffic-calibration/         Cloudflare Radar 风格业务校准资料
  exports/                     第一阶段导出的真值场景
  reports/                     验收和审计报告
  dist/                        前端构建产物
  node_modules/                本地依赖

  project-docs/                已归档的阶段性说明文件和截图资源
```

旧版说明文件已集中移动到：

```text
project-docs/legacy-root-docs/
```

归档索引见：

```text
project-docs/README.md
```

## 2. 项目要解决的问题

LEO 卫星网络具有强动态性：

- 卫星持续高速运动；
- 轨间链路会随距离、极区限制、地球遮挡等条件断开或恢复；
- 星地链路受地面站可见窗口限制；
- 业务流量会导致节点 CPU、队列、能耗和链路利用率变化；
- 遥测报告还需要通过有限星地窗口回传地面。

因此，地面运维系统不能假设自己天然知道全网状态。本项目的核心目标是建立一个实验闭环：

```text
业务输入
  -> LEO 卫星网络动态仿真
  -> 每个时间片的节点/链路真值
  -> INT 报文逐跳采集
  -> Ground OAM 重构全网状态
  -> 与真值对照评估覆盖率和误差
```

这个闭环可以用于验证：

- INT 能否覆盖动态 LEO 网络；
- 哪些节点和链路没有被观测到；
- 报告回传窗口是否会限制全网感知；
- 主动探测路径是否比单纯业务路径遥测更有效；
- 低开销遥测算法是否能在准确率和开销之间取得平衡。

## 3. 第一阶段：卫星网络真值模型

第一阶段模型位于 `src/` 和 `scripts/`，主要负责生成黑盒真值环境。

### 3.1 轨道与星座

项目支持三类轨道模式：

| 模式 | 用途 |
|---|---|
| 解析 Walker | 规则、可解释、便于观察拓扑结构。 |
| 合成 TLE + SGP4 | 保持 Walker 结构，同时使用 SGP4 传播位置。 |
| 真实 TLE + SGP4 | 接入 CelesTrak GP/OMM 快照，使用真实公开轨道数据传播。 |

当前仪表盘已经提供三档星座模型切换。为了保证浏览器首屏稳定打开，网页默认加载小型 Iridium NEXT；切换到中型 Telesat-1015 时，前端默认预览前 12 个时间片；切换到大型 Starlink 时，前端默认只预览前 4 个时间片。正式实验仍可通过脚本运行完整 48 个时间片，实验脚本不受网页预览限制影响。

| 规模 | 真实星座依据 | 当前模型规模 | 主要用途 |
|---|---|---:|---|
| 小型 | Iridium NEXT | `6x11 = 66` | 小规模 crosslinked Walker-Star、极区和 seam 约束、低开销遥测基线 |
| 中型 | Telesat / Hypatia Telesat-1015 | `27x13 = 351` | 中规模传统 LEO 仿真 ISL 网络、INT-MC / CoSTCo 补全、覆盖率-开销实验 |
| 大型 | Starlink 主实验壳层 | `72x22 = 1584` | 后续正式 INT / INT-MC / CoSTCo 大规模实验 |

三档模型统一通过 CelesTrak GP/TLE 快照和 `real-tle-sgp4` 传播生成。Starlink `47x14`、`8x8` 等早期中间/轻量快照只作为历史开发产物保留，不再作为正式实验、调参或论文结果来源；需要缩短运行时间时，优先在三档正式规模上减少时间片数量。

当前真实 TLE 快照示例位于：

```text
data/tle-snapshots/
```

常用快照包括：

```text
celestrak-iridium-next-real-walker-6x11.json             # Iridium NEXT 小型 crosslinked Walker-Star
synthetic-telesat-1015-hypatia-walker-27x13.json         # Telesat/Hypatia 中型 ISL 网络
celestrak-starlink-real-walker-72x22.json                # Starlink 大型主实验网络
```

### 3.2 节点状态

每颗卫星节点会维护资源和运行状态，例如：

- `node_id`
- `node_type`
- `cpu_capacity`
- `memory`
- `storage`
- `energy`
- `batteryPercent`
- `cpuLoadPercent`
- `queueDepth`
- `temperatureC`
- `participatingTasks`
- `sourceTasks`
- `transitTasks`
- `healthStatus`

在空业务输入下，CPU 和任务负载应接近空闲状态；在业务输入后，节点状态由业务转发、队列、能耗和链路负载共同驱动。

### 3.3 链路状态

项目建模了星间链路和星地链路：

- 轨内 ISL：同一轨道面内相邻卫星之间的稳定链路；
- 轨间 ISL：相邻轨道面卫星之间的动态链路；
- SGL：卫星到地面站的星地链路。

链路状态包括：

- `status`
- `is_active`
- `distance_km`
- `latency_ms`
- `capacity_mbps`
- `utilization_percent`
- `snr_db`
- `sinr_db`
- `restriction_reason`
- `queue_delay_ms`
- `packet_loss`

链路可用性会受以下因素影响：

- 距离阈值；
- 极区断链；
- 地球遮挡；
- 天线数量和指向；
- 星地可见窗口；
- 链路预算；
- 同频/邻频干扰；
- 业务拥塞。

### 3.4 业务输入

业务数据集位于：

```text
examples/datasets/
```

常用示例：

```text
stage1-standard-traffic.csv
stage1-ml-48-traffic.csv
radar-calibrated-starlink-72x22-48-traffic.csv
real-starlink-72x22-ml-48-traffic.csv
```

业务数据集用于描述在某个时间片生成的任务流量，包括源节点、目的节点、带宽、计算需求、持续时间、优先级等。模型会根据路由和链路状态计算这些业务对卫星网络的影响。

## 4. 第二阶段：INT 遥测系统

第二阶段位于：

```text
stage2-int/
```

它将第一阶段模型视为黑盒真值环境。INT 运行过程中不能直接读取全网真值，只能通过报文经过的节点和链路采集局部状态。

### 4.1 traffic-int

`traffic-int` 表示业务流自然携带 INT metadata。

特点：

- 只观测业务实际经过的路径；
- 遥测开销较低；
- 覆盖范围受业务分布影响；
- 容易漏掉没有业务经过的链路。

### 4.2 probe-int

`probe-int` 表示主动探测。

特点：

- 系统主动规划 probe path；
- 可以覆盖更多 ISL；
- 遥测开销高于 traffic-int；
- 适合复现网络级全网遥测过程。

当前支持的路径算法包括：

- `path-original`
- `path-balance`

后续可以扩展：

- `int-mc`
- `adaptive-probe`
- `congestion-aware`
- `energy-aware`

当前已经落地的 `int-mc` 是卫星适配版 LEO-INT-MC。它不直接移植 Mininet/P4 原型，而是在现有第二阶段管线中新增两步：

- 根据 TLE/SGP4 拓扑快照生成 contact plan，并从 `path-balance` 候选路径中选择少量高信息 probe path；
- Ground OAM 收到部分 INT 报告后，对物理可用但未观测的链路做矩阵补全，物理断链保持 `topology-down`。

运行示例：

```bash
npm run int:experiment -- --tasks examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --out stage2-int/runs/int-mc-main-72x22 --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --mode operational --algorithm int-mc --int-mc-sampling-rate 0.25 --int-mc-rank 5 --int-mc-window 12
```

关键产物：

```text
stage2-int/probe-paths-int-mc.csv
stage2-int/probe-coverage-int-mc.json
stage2-int/int-mc-contact-plan-int-mc.json
stage2-int/ground-probe-int-mc/ground-mc-reconstructed-links.csv
stage2-int/ground-probe-int-mc/int-mc-evaluation.json
```

### 4.3 Ground OAM

Ground OAM 是地面运维与管理系统。它接收 INT sink 生成的遥测报告，并尝试重构当前网络状态。

Ground OAM 的输入不是第一阶段真值，而是：

```text
INT hop records
INT reports
reporting path delivery result
```

它输出：

- 已观测节点；
- 已观测链路；
- 未观测对象；
- 重构覆盖率；
- 与真值对照后的误差报告。

## 5. 快速启动

安装依赖：

```bash
npm install
```

启动网页仪表盘：

```bash
npm run dev
```

终端会输出本地访问地址，通常类似：

```text
http://localhost:5173/
```

构建前端：

```bash
npm run build
```

## 6. Git 版本回滚

当前目录已经初始化为本地 Git 仓库，并创建了项目基线提交。后续修改代码或文档前，可以先查看状态：

```bash
git status
```

保存新的检查点：

```bash
git add .
git commit -m "说明本次修改内容"
```

查看提交历史：

```bash
git log --oneline
```

撤销某个未提交文件的修改：

```bash
git restore path/to/file
```

撤销所有未提交修改：

```bash
git restore .
```

如果需要回到某个历史提交，先查看提交号：

```bash
git log --oneline
```

然后谨慎执行：

```bash
git reset --hard <commit_id>
```

`git reset --hard` 会丢弃当前未提交修改，执行前建议先用 `git status` 确认状态，必要时使用：

```bash
git stash
```

当前 `.gitignore` 已排除依赖、构建产物、临时日志和实验输出目录，包括：

```text
node_modules/
dist/
exports/
reports/
stage2-int/runs/
stage2-int/outputs/
project-docs/archived-runtime-artifacts/
```

## 7. 常用命令

### 7.1 第一阶段验收

```bash
npm run verify:stage1
```

用途：

- 检查卫星网络真值模型是否可以正常生成；
- 检查节点、链路、业务、导出字段是否满足当前阶段要求。

### 7.1.1 Starlink 保真补强验收

```bash
npm run verify:stage1:starlink
```

用途：

- 检查默认轻量星座是否采用 Starlink 主壳层近似高度/倾角；
- 检查 Starlink 主壳层 `72x22` 真实 TLE 快照是否可用；
- 实际导出 real-tle-sgp4 的三类小时间片真值，证明第一阶段既能对齐 `53°/550 km` 主壳层，也能运行更大规模真实公开快照。

### 7.1.2 三档真实星座验收

```bash
npm run verify:constellations
```

用途：

- 检查 Iridium NEXT `6x11`、Telesat-1015 `27x13`、Starlink `72x22` 三档快照是否可用；
- 检查每档模型的节点数、轨道面/槽位映射和最小时间片拓扑是否可以生成；
- 明确中型模型采用 Hypatia 传统 Telesat-1015 设计参数生成合成 TLE，以保证中等规模模型具备 ISL，可用于 INT/INT-MC 实验。

### 7.2 总体验收

```bash
npm run verify:goal
```

用途：

- 检查第一阶段模型；
- 检查第二阶段 INT 实验；
- 检查 Ground OAM 重构；
- 检查关键产物是否存在。

当前正式实验默认输入为 Starlink 主壳层 `72x22` 真实 TLE 快照和 Radar 校准业务数据集。调试时可以追加 `--slices <N>` 缩短实验时间片。8x8 等早期轻量规模只保留为历史开发/本地 smoke 产物，不再作为实验部分的运行对象或结果来源。

### 7.3 校验业务数据集

```bash
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
```

用途：

- 检查业务数据字段；
- 检查源/目的节点是否存在；
- 检查时间片范围；
- 检查业务是否能被当前星座配置解释。

### 7.4 导出第一阶段真值场景

```bash
npm run export:scenario -- --tasks examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --mode operational --out exports/radar-calibrated-starlink-72x22-48
```

输出通常包括：

```text
truth.json
nodes.csv
links.csv
routes.csv
metrics.csv
manifest.json
```

### 7.5 运行 INT 实验

```bash
npm run int:experiment -- --tasks examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --mode operational --algorithm path-balance --out stage2-int/runs/radar-calibrated-72x22
```

输出通常包括：

```text
int-experiment-manifest.json
traffic-int reports
probe-int hop records
probe-int reports
ground-reconstructed-nodes.csv
ground-reconstructed-links.csv
ground-oam-evaluation.json
int-process-visualization.json
```

### 7.6 获取真实 TLE 快照

```bash
npm run tle:fetch
```

生成 Starlink `53°/550 km` 主壳层快照时建议显式指定目标壳层：

```bash
npm run tle:fetch -- --planes 72 --satellites-per-plane 22 --out data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
```

校验快照：

```bash
npm run tle:verify -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
```

### 7.7 生成业务数据集

生成真实星座快照风格业务：

```bash
npm run generate:real-traffic
```

生成 Cloudflare Radar 风格校准业务：

```bash
npm run generate:radar-traffic
```

### 7.8 生成第一阶段真实化数据集

```bash
npm run dataset:stage1:realistic
```

默认行为：

- 使用 `celestrak-starlink-real-walker-72x22.json` 作为真实公开 TLE-SGP4 快照；
- 使用 `traffic-calibration/cloudflare-radar-profile.json` 生成公开统计特征校准业务；
- 导出 `nodes.csv`、`links.csv`、`routes.csv`、`metrics.csv` 和数据集 manifest；
- 输出目录默认为 `exports/stage1-realistic-72x22-48/`。

正式实验不再运行 8x8 等早期轻量快照。需要缩短调试时间时，应优先在三种正式规模上使用 `--slices <N>` 减少时间片，而不是更换到非正式星座规模。

### 7.9 实验 1：基于外部公开数据的仿真真实性验证

该实验不再使用内部一致性评分来证明模型“自洽”，而是把第一阶段模型输出与外部公开数据进行对照。默认对照源包括 CelesTrak Starlink GP/TLE、Cloudflare Radar AS14593 业务数据入口、RIPE Atlas AS14593 Starlink 探针公开测量。实验会客观展示轨道、星座规模、业务流量和网络性能四类对照结果；如果缺少 Cloudflare Radar token 或外部 CSV，也会在报告中明确标注“业务流量强外部验证未完成”。网络性能对照采用用户侧 RTT 口径：根据 RIPE 探针位置、模型卫星几何和区域网关/PoP 抽象估计 `用户-卫星-网关` RTT，再与 RIPE Atlas ping 比较；内部任务路由时延仍保留为星座压力指标，不直接拿来验证公开 ping。

```powershell
npm run generate:radar-traffic -- --snapshot data\tle-snapshots\celestrak-starlink-real-walker-72x22.json --profile traffic-calibration\cloudflare-radar-profile.json --radar-json reports\_archive\experiment1-pre-final-20260703-211932\experiment1-external-realism-72x22\external\cloudflare-radar\radar-as14593-traffic.json --radar-window latest --out reports\experiment1-satellite-data-authenticity\input\radar-fitted-traffic.csv --metadata-out reports\experiment1-satellite-data-authenticity\input\radar-fitted-traffic.metadata.json --slices 48

npm run experiment:realism -- --out reports\experiment1-satellite-data-authenticity --snapshot data\tle-snapshots\celestrak-starlink-real-walker-72x22.json --tasks reports\experiment1-satellite-data-authenticity\input\radar-fitted-traffic.csv --slices 48 --radar-json reports\_archive\experiment1-pre-final-20260703-211932\experiment1-external-realism-72x22\external\cloudflare-radar\radar-as14593-traffic.json --radar-window latest --ripe-max-probes 16 --ripe-hours 4

npm run experiment1:internal-plausibility -- --out reports\experiment1-satellite-data-authenticity
```

正式实验使用 `72x22` 真实 TLE-SGP4 壳层快照和 Radar 原始时序驱动业务输入，输出目录：

```text
reports/experiment1-satellite-data-authenticity/
```

其中 `experiment1-research-report.html/md` 是研究级总结报告，`external-realism-report.html/json` 是自动外部对照报告；`experiment1-internal-state-plausibility.html/json` 是新增的内部状态可信性审计报告，用来验证 CPU、电量、队列、缓存等外部不可直接观测变量是否满足公式、边界和输入响应约束；`user-facing-rtt-comparison.csv` 记录每个 RIPE 探针样本对应的时间片、接入卫星、区域网关、星间回退路径和模型用户侧 RTT。详细说明见 `project-docs/EXPERIMENT_1_SIMULATION_FIDELITY.md`。

## 8. 仪表盘功能

仪表盘主要用于观察和下载实验结果。

核心视图包括：

- 3D 卫星拓扑；
- 2D 时间片拓扑；
- 节点状态面板；
- 链路状态面板；
- 第一阶段真值概览；
- 业务流量和路由结果；
- INT 遥测仿真页面；
- Ground OAM 重构结果；
- 真值对照检验；
- 数据下载区。

在 INT 遥测页面中，需要注意视角区别：

- 遥测过程视角只展示 INT 已观测或已重构的信息；
- 第一阶段真值只应出现在检验区域；
- 未观测节点和链路必须保留 unknown 状态；
- 补全或推断结果不能被当成真实采样结果。

## 9. 输入与输出

### 9.1 主要输入

| 输入 | 位置 | 说明 |
|---|---|---|
| 星座配置 | `src/config/` | Walker/TLE、链路、天线、能耗等配置。 |
| TLE 快照 | `data/tle-snapshots/` | 真实公开轨道快照。 |
| 业务数据集 | `examples/datasets/` | 外部任务流量输入。 |
| 遥测配置 | `stage2-int/config/` | INT 实验参数。 |

### 9.2 主要输出

| 输出 | 位置 | 说明 |
|---|---|---|
| 第一阶段真值 | `exports/` | 节点、链路、路由、网络指标。 |
| INT 实验结果 | `stage2-int/runs/` | hop records、reports、Ground OAM 重构。 |
| 验收报告 | `reports/` | 阶段验收和总体目标验收。 |
| 前端构建 | `dist/` | 构建后的网页产物。 |

## 10. 数据真实性边界

当前项目可以接入真实公开 TLE 快照，并使用 SGP4 传播轨道位置；实验 1 进一步把模型输出与外部公开数据对照，而不是只做内部一致性验证。当前可用的外部对照包括：

- CelesTrak / Space-Track 类公开 TLE/GP 目录：用于验证轨道、壳层和星座分布；
- Cloudflare Radar AS14593：用于验证 Starlink ASN 侧公开业务流量趋势，需 API token 或用户导出 CSV；
- RIPE Atlas AS14593 探针：用于验证 Starlink 接入侧公开 RTT/丢包量级，当前项目通过用户侧 RTT 估计与其对照，不把内部星间任务路由时延直接等同于 RIPE ping；
- 公开测量论文和报告：用于解释 Starlink 性能范围和外部观测边界。

但是需要明确：

- 如果没有 Cloudflare Radar API token 或外部 CSV，业务流量只能称为公开统计特征校准，不等同于真实运营商内部流量；
- 公开世界基本拿不到逐星 CPU、电池、队列和每条 ISL 的真实运营状态，这些字段是外部轨道/业务/性能约束后的仿真真值；
- 链路预算和能耗模型是中高层抽象，不是硬件级射频链路仿真；
- INT 过程是协议机制和状态采集逻辑复现，不是 P4/Tofino/ns-3 级逐包实现；
- Ground OAM 的重构结果需要和第一阶段真值区分。

因此，本项目适合称为：

```text
面向 LEO 网络状态与 INT 遥测研究的中高仿真模型
```

不应称为：

```text
完全真实运营级卫星互联网数字孪生
```

## 11. 后续研究方向

当前项目已经具备继续扩展的基础。后续优先方向包括：

1. **INT-MC 低开销遥测优化**
   当前已经接入 LEO-INT-MC，后续重点是进一步评估不同采样率、预测误差、真实 TLE 快照和更大星座规模下的补全精度与遥测开销。

2. **机器学习预测数据集**  
   使用每个时间片的节点/链路状态训练模型，预测下一时间片的负载、拥塞、电量或链路状态。

3. **更真实业务校准**  
   引入更多公开流量统计来源或真实业务 trace，用于校准任务生成器。

4. **更严格协议级实现**  
   如果需要与真实网络协议栈对齐，可进一步引入 ns-3、P4 或容器网络仿真。

## 12. LEO-INT-MC 拓扑预测与效率折中

当前第二阶段 `int-mc` 已经加入预测 contact plan，不再假设每个时间片都从零重算全局拓扑。运行 `npm run int:experiment -- --algorithm int-mc` 时，流水线会先根据第一阶段导出的轨道和链路物理参数生成：

```text
stage2-int/predicted-contact-plan.json
stage2-int/predicted-contact-plan.csv
stage2-int/predicted-contact-plan-summary.csv
stage2-int/predicted-contact-plan-evaluation.json
```

默认参数会自动贴合第一阶段时间片设置：当前 5 分钟一个时间片、LEO 约 90 到 95 分钟一圈，因此矩阵补全窗口约为 18 个时间片，预测 horizon 约为 36 个时间片，预测计划约每 6 个时间片刷新一次。这样既利用了星历带来的可预测性，又避免在每个时间片都进行昂贵的全局重算。

运行边界如下：

- 预测 contact plan 只给出链路物理可接触先验，不填充链路利用率、拥塞、CPU、电量等状态。
- INT-MC 仍然只根据成功下传的 INT reports 构造 observed mask。
- 物理上预测为 down 的链路保持 `topology-down`，不会被矩阵补全。
- 物理可接触但没有被 INT 观测到的链路才进入矩阵补全。
- 第一阶段真值只用于实验结束后的 precision、recall、Jaccard、误差和准确率评估。

一次标准命令示例：

```powershell
npm run int:experiment -- --tasks examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --out stage2-int/runs/int-mc-contact-plan-72x22 --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --mode operational --algorithm int-mc
```

在最新 smoke run 中，48 个时间片下生成 5760 个链路样本，预测 contact plan 的 precision/recall/accuracy 均为 1，INT-MC 对 4971 个 active 链路样本完成 100% active-link completion，其中 3862 个来自直接 INT 观测，1109 个由矩阵补全推断得到。

## 13. 实验 4-7：LEO-INT-MC 机制验证

实验 2-11 的当前正式结果、共享输入、证据角色和历史归档边界统一记录在 [实验 2-11 正式结果索引](EXPERIMENTS_2_TO_11_INDEX.md) 中。论文图表应只从该索引列出的正式目录生成。严格等实际字节预算的多种子结果见 [实验 10 报告](EXPERIMENT_10_EQUAL_BUDGET_REPORT.md)，动态等预算机制消融见 [实验 11 报告](EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md)，投稿证据边界见 [INFOCOM 审计](INFOCOM_READINESS_AUDIT.md)，本轮完整过程见 [7.11 工作日志](7.11工作日志.md)。

实验 4-7 用于补足实验 2 的机制解释、完整开销、参数稳定性和部署合法性证据。正式实验均使用 Iridium 66、Telesat 351、Starlink 1584 三种规模和 48 个时间片。

| 实验 | 研究问题 | 根目录报告 | 详细可视化 | 复现命令 |
|---|---|---|---|---|
| 实验 4：消融实验 | 各类 LEO 增强机制分别贡献了什么，是否存在负贡献或规模差异 | [EXPERIMENT_4_ABLATION_REPORT.md](EXPERIMENT_4_ABLATION_REPORT.md) | [HTML](reports/experiment4-leo-int-mc-ablation/experiment4-ablation-report.html) | `npm run experiment4:ablation` |
| 实验 5：开销分解 | 遥测字节、ISL 承载、能耗、路径规划和补全计算分别占多少 | [EXPERIMENT_5_OVERHEAD_REPORT.md](EXPERIMENT_5_OVERHEAD_REPORT.md) | [HTML](reports/experiment5-overhead-decomposition/experiment5-overhead-report.html) | `npm run experiment5:overhead` |
| 实验 6：采样率敏感性 | 5%-40% 采样率下，开销、误差、波动和 Pareto 折中是否稳定 | [EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md](EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md) | [HTML](reports/experiment6-sampling-sensitivity/experiment6-sampling-report.html) | `npm run experiment6:sampling` |
| 实验 7：无真值泄漏合法性 | 规划是否读取隐藏真值或未来反馈，补全是否破坏观测值和物理掩码 | [EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md](EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md) | [HTML](reports/experiment7-no-truth-leakage/experiment7-report.html) | `npm run experiment7:legality` |

实验 7 是实验 4-6 的合法性门槛。若反事实 probe plan 哈希、因果滞后、观测值锁定、inactive mask 或真值使用边界任一检查失败，相关性能结果只能视为暂定结果，不能作为可部署算法的正式证据。

## 14. 文档归档

为保持根目录简洁，旧版说明文件和截图已经归档到：

```text
project-docs/
```

入口：

```text
project-docs/README.md
```

其中：

- `legacy-root-docs/` 保存旧版详细说明；
- `assets/` 保存历史截图；
- `archived-runtime-artifacts/` 保存清理根目录时移入的临时日志、截图和临时运行目录。
