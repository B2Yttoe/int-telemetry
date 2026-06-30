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

当前真实 TLE 快照示例位于：

```text
data/tle-snapshots/
```

常用快照包括：

```text
celestrak-starlink-real-walker-8x8.json
celestrak-starlink-real-walker-72x22.json
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
radar-calibrated-starlink-8x8-48-traffic.csv
radar-calibrated-starlink-72x22-48-traffic.csv
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

### 7.2 总体验收

```bash
npm run verify:goal
```

用途：

- 检查第一阶段模型；
- 检查第二阶段 INT 实验；
- 检查 Ground OAM 重构；
- 检查关键产物是否存在。

### 7.3 校验业务数据集

```bash
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-8x8-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json
```

用途：

- 检查业务数据字段；
- 检查源/目的节点是否存在；
- 检查时间片范围；
- 检查业务是否能被当前星座配置解释。

### 7.4 导出第一阶段真值场景

```bash
npm run export:scenario -- --tasks examples/datasets/radar-calibrated-starlink-8x8-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json --mode operational --out exports/radar-calibrated-starlink-8x8-48
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
npm run int:experiment -- --tasks examples/datasets/radar-calibrated-starlink-8x8-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json --mode operational --algorithm path-balance --out stage2-int/runs/radar-calibrated-8x8
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

校验快照：

```bash
npm run tle:verify -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json
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

当前项目可以接入真实公开 TLE 快照，并使用 SGP4 传播轨道位置。这增强了轨道层真实性。

但是需要明确：

- 业务流量通常仍是由公开统计特征或示例数据校准生成，不等同于真实运营商内部流量；
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

1. **INT-MC 接入**  
   使用矩阵补全降低全网遥测开销。需要针对 LEO 动态拓扑引入 contact plan、滑动窗口、active mask 和路径模板复用。

2. **机器学习预测数据集**  
   使用每个时间片的节点/链路状态训练模型，预测下一时间片的负载、拥塞、电量或链路状态。

3. **更真实业务校准**  
   引入更多公开流量统计来源或真实业务 trace，用于校准任务生成器。

4. **更严格协议级实现**  
   如果需要与真实网络协议栈对齐，可进一步引入 ns-3、P4 或容器网络仿真。

## 12. 文档归档

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
