# Walker 卫星网络仿真系统使用指南

本文档用于说明当前项目如何运行、如何配置、如何上传任务数据，以及当前系统的仿真程度和完善程度。

## 1. 项目定位

本项目是一个面向 Walker-Star LEO 卫星网络的拓扑仿真与全网感知仪表盘。它的重点不是高精度轨道力学，而是把 Walker 星座结构、时间片拓扑变化、星间链路连接/断开、节点资源状态和三维可视化统一展示出来。

当前收尾阶段已经形成完整实验闭环：外部业务数据集可以进入第一阶段高仿真卫星网络模型，第二阶段通过 INT / probe-int 遥测和 Ground OAM 重构得到全网节点与链路状态，并生成准确率报告和总体验收报告。

当前系统更适合作为：

- LEO 卫星网络拓扑动态性展示工具。
- Walker-Star 星座连通性实验原型。
- 节点资源、链路状态、任务负载和能量状态的可视化演示平台。
- INT 网络遥测复现实验的本地仿真底座。
- 后续接入真实 TLE 星历源、真实业务流量和更高级遥测机制的前端/仿真骨架。

它暂时不适合作为：

- 高保真轨道动力学仿真器。
- 真实 Starlink 星座精确复现工具。
- 高保真链路预算、通信物理层、精细天线指向、干扰建模工具。
- 端到端业务流经过多跳星间链路的完整网络仿真器。

## 2. 快速运行

安装依赖：

```bash
npm install
```

启动开发服务器：

```bash
npm run dev
```

默认 Vite 会输出本地访问地址，通常类似：

```text
http://localhost:5173
```

构建生产版本：

```bash
npm run build
```

预览生产版本：

```bash
npm run preview
```

如果 Windows PowerShell 阻止 `npm.ps1` 执行，可以改用：

```bash
npm.cmd run dev
npm.cmd run build
```

### 2.1 收尾阶段总体验收

如果目标是确认整个项目是否完成“外部业务数据集 -> 卫星网络仿真 -> INT 全网感知状态 -> 准确率报告”的闭环，运行：

```bash
npm run verify:goal
```

该命令会自动执行：

1. 第一阶段仿真模型验收。
2. 标准外部业务数据集校验。
3. 第二阶段 INT 端到端实验。
4. INT 实验复验。
5. 前端构建。
6. 总体验收报告生成。

输出报告：

```text
reports/goal/goal-e2e-verification.json
reports/goal/goal-e2e-verification.md
```

当前标准通过结果应满足：

```text
summary.pass = true
summary.failed = 0
stage1_score = 100
probe_node_coverage = 1
probe_link_coverage = 1
probe_full_time_step_pass = true
```

更详细的复现实验流程见 [EXPERIMENT_REPRODUCTION_GUIDE.md](./EXPERIMENT_REPRODUCTION_GUIDE.md)。

### 2.2 常用复现命令

校验标准业务数据集：

```bash
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv
```

运行第二阶段 INT 端到端实验：

```bash
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/reproduce-standard --orbit tle-sgp4 --mode operational --algorithm path-balance
```

复验某个 INT run：

```bash
npm run int:verify -- --run stage2-int/runs/reproduce-standard
```

网页端查看离线实验结果：

```bash
npm run dev
```

然后在 `遥测仿真` 页面导入：

```text
stage2-int/runs/reproduce-standard/int-experiment-manifest.json
```

## 3. 主要目录

```text
src/config/walkerNetworkConfig.ts    星座、时间片、链路、节点资源和能量模型配置
src/simulation/types.ts              仿真数据结构定义
src/simulation/tle.ts                合成 TLE 目录生成与 SGP4 轨道传播
src/simulation/walker.ts             Walker 星座、轨道传播、链路和节点状态计算
src/components/OrbitalScene.tsx      Three.js 三维地球、轨道面、卫星和链路场景
src/components/PlanarTopology.tsx    按时间片展开的二维卫星拓扑视图
src/App.tsx                          仪表盘页面、模式切换、数据上传和状态面板
src/styles.css                       页面样式
stage2-int/                          第二阶段 INT 遥测实验工具、配置、报告和 run 输出
reports/goal/                        项目总体验收报告
EXPERIMENT_REPRODUCTION_GUIDE.md     收尾阶段详细复现实验手册
```

## 4. 默认仿真配置

当前默认星座配置：

```text
Walker 类型：star
轨道面数量：8
每个轨道面卫星数量：8
卫星总数：64
轨道高度：1200 km
轨道倾角：86.4 度
时间片数量：24
时间片步长：5 分钟
单时间片候选链路数：120
```

当前链路规则：

- 轨内链路始终作为候选链路存在。
- 轨间链路只在相邻轨道面之间匹配，不再固定要求同槽位卫星相连。
- 相邻轨道面内会按当前时间片的空间距离优先选择最近且可用的跨轨组合。
- 每颗卫星最多 4 条链路。
- 轨间链路超过距离阈值会断开。
- 卫星进入极地区域后，不建立轨间链路。
- 如果地球遮挡导致不可视，轨间链路断开。
- 三维拓扑图只显示当前处于连接状态的链路。
- 二维时间片拓扑图同样只绘制当前处于连接状态的链路。

当前天线默认配置：

```text
ISL 天线：front / back / left / right
ISL 频段：laser
ISL 最大距离：6500 km
ISL 带宽：2500 Mbps
ISL 最大同时波束：1
SGL 天线：earth-facing
SGL 频段：Ka
SGL 最大距离：4200 km
SGL 最小仰角：25°
SGL 上报容量：600 Mbps
默认地面站：北京密云、新疆喀什、海南文昌、阿拉斯加费尔班克斯
天线捕获时间：2 s
跟踪环路滞后：0.8 s
ISL 指向抖动：0.05°
SGL 指向抖动：0.15°
最低时间片可用比例：0.85
```

当前链路预算默认配置：

```text
ISL 频率：193500 GHz（1550 nm 光链路近似）
ISL 信道带宽：2500 MHz
ISL 最低 SNR：6 dB
SGL 频率：20 GHz（Ka 下行近似）
SGL 信道带宽：600 MHz
SGL 地面站接收增益：48 dBi
SGL 最低 SNR：5 dB
链路预算损耗项：实现损耗 + 大气损耗 + 极化损耗 + 指向损耗 + 多普勒残差损耗 + 太阳干扰损耗
干扰项：ISL 邻星同频/邻频干扰 + SGL 多卫星下行同频/邻频干扰
频率复用：ISL 默认 4 个信道，SGL 默认 3 个信道；超出最大邻频间隔的潜在干扰直接滤除
SGL 干扰方向图：卫星端按地向天线离轴角，地面端按 2.4° 接收波束宽度近似
动态指向项：按上一时间片目标、转向角、转向速度和波束宽度计算
多普勒项：按视线方向径向相对速度计算频移、补偿残差和损耗
环境噪声项：按太阳 ECI 方向、接收波束夹角和等效噪声温度抬高噪声功率
ISL 太阳规避：太阳夹角小于 6° 时断开，6°-12° 时按二次函数加入太阳干扰损耗
SGL 安静天空噪声：25 K，太阳噪声温度近似：120000 K
ISL 多普勒补偿范围：12 GHz，最大残差：25 MHz
SGL 多普勒补偿范围：900 kHz，最大残差：60 kHz
星地动态天气项：雨强 + 雨层高度 + 气体天顶损耗 + 云液态水含量 + 闪烁衰落
天气时间序列：每个地面站配置 minute 样本，时间片之间线性插值
当前雨强范围：0.02-28 mm/h
容量公式：C = B log2(1 + SNR/SINR)
有效容量：min(C_shannon, C_mcs, C_antenna) × (1 - PER) × 天线可用比例，并受多普勒残差损耗影响
MCS 目标包错误率：1e-3，默认包长 1024 bytes
```

当前资源默认配置：

```text
CPU 算力：256 GOPS
GPU 算力：32 TOPS
内存：128 GB
存储：4096 GB
初始电量：72%
电池容量：1200 Wh
最低 SoC 阈值：20%
太阳翼面积：2.0 m²
太阳翼效率：0.28
太阳常数：1361 W/m²
太阳翼峰值发电：约 762 W
充电效率：0.95
放电效率：0.95
基础功耗：80 W
通信功耗：100 W
计算功耗：50 W
载荷功耗：100 W
标称整星负载：330 W
```

这些数值是第一版工程假设，用于 LEO 边缘计算仿真演示，不代表某一真实卫星型号的公开硬件参数。它们已经比单纯随机状态更可解释，但仍没有覆盖姿态、太阳翼指向、温控和电池老化等真实细节。

## 5. 仪表盘使用方式

页面顶部提供两种仿真模式：

- `自主模拟`：不需要外部数据，节点状态按内置波动模型生成。
- `真实运行`：节点 CPU、GPU、内存、存储、队列、温度和电量由任务数据与光照状态计算。

页面默认进入 `真实运行 + TLE + SGP4 + 正常业务`。这是第一阶段验收、场景矩阵和命令行导出的默认研究口径；`自主模拟` 与 `解析 Walker` 保留用于演示和对照。

页面顶部还提供：

- 时间片滑条：选择某一个时间片。
- `运动`：取消快照选择，让卫星持续运动。
- 轨道模型切换：`解析 Walker` 用于清晰规则的拓扑观察，`TLE + SGP4` 用于基于 TLE 的轨道传播。
- `轨道面` 开关：显示或隐藏轨道面。
- `节点` 开关：显示或隐藏卫星节点。
- `链路` 开关：显示或隐藏星间链路。
- 数据集上传：上传 CSV 或 JSON 任务数据。

三维场景支持：

- 鼠标拖拽旋转。
- 滚轮缩放。
- 点击卫星节点查看节点状态。
- 时间片快照下查看当前链路连接状态。

二维时间片拓扑支持：

- 横向按轨道面展开。
- 纵向按轨道面内槽位展开。
- 轨内链路与轨间链路分色显示。
- 只绘制当前时间片处于连接状态的链路。
- 点击节点或链路后，右侧详情面板会同步更新。
- 使用二维图中的 `T00`、`T01` 等按钮，可以直接查看不同时间点的平面拓扑快照。

节点状态栏中，半长轴、倾角、RAAN、平均运动、轨道周期等不常变化的轨道参数已折叠到 `轨道静态参数` 中，可以点击展开。切换到 `TLE + SGP4` 后，节点详情会显示 NORAD ID、卫星名称、COSPAR ID 和原始 TLE 两行数据。

## 5.1 二维拓扑视图说明

二维拓扑图不是重新生成一套网络，而是读取当前时间片的 `nodes` 和 `links`：

- 节点位置来自当前 Walker / TLE + SGP4 传播结果。
- 链路状态来自同一时间片的距离阈值、极区限制和地球遮挡计算。
- 已断开的链路不会显示在二维图中，避免图形和链路表状态不一致。
- 极区节点会用虚线轮廓提示，便于观察极区限制对轨间链路的影响。

因此，二维拓扑适合观察“某一个时间点网络到底怎么连”，三维拓扑适合观察“卫星在空间中如何运动”。

## 5.2 轨道模型说明

当前系统保留两种轨道传播模式：

- `解析 Walker`：直接根据 Walker 壳层参数、轨道面 RAAN、槽位相位和圆轨道角速度计算位置。它的优点是结构最清晰，适合观察轨道面、槽位和链路规则。
- `TLE + SGP4`：先由当前 Walker 参数生成一组合成 TLE，再使用 `satellite.js` 的 SGP4 模型传播每颗卫星的位置和速度。它的优点是数据结构接近公开轨道建模流程，同时仍保持 Walker 星座的可预测可视化结构。

注意：当前 `TLE + SGP4` 模式使用的是合成 TLE，不是直接从 CelesTrak、Space-Track 或真实 Starlink 目录下载的历史 TLE。这样做是为了先把传播链路打通，同时避免真实星座数据导致轨道面、槽位和演示拓扑突然变得难以解释。

## 6. 任务数据上传格式

仪表盘提供七种业务入口：

| 业务模式 | 用途 |
| --- | --- |
| 空业务 | 验证 CPU/GPU/队列/ISL 转发负载为空，能量只由光照和空载功耗驱动 |
| 低负载 | 验证低业务流量可稳定路由且不形成拥塞 |
| 正常业务 | 默认确定性业务模板 |
| 高负载 | 验证链路容量、节点 CPU、通信功耗、缓存和队列随压力升高 |
| 热点业务 | 验证局部节点和局部链路压力集中 |
| 突发业务 | 验证短时间大流量造成拥塞、队列和丢弃 |
| 长时业务 | 验证业务跨多数时间片持续运行 |
| 上传数据 | 使用用户 CSV/JSON 数据集驱动仿真 |

正式字段定义见 `schemas/task-dataset.schema.json`，样例数据说明见 `examples/datasets/README.md`。

CSV 示例：

```csv
task_id,time,start_slice,duration_slices,source,target,node_id,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type
T-A,T00,0,4,P01-S01,P05-S08,,128,8,16,80,200,2,mixed
T-B,T02,2,3,,,P02-S03,96,4,8,40,120,1,compute
```

JSON 示例：

```json
[
  {
    "task_id": "T-A",
    "time": "T00",
    "start_slice": 0,
    "duration_slices": 4,
    "source": "P01-S01",
    "target": "P05-S08",
    "compute_units": 128,
    "gpu_units": 8,
    "memory_gb": 16,
    "storage_gb": 80,
    "traffic_mbps": 200,
    "priority": 2,
    "task_type": "mixed"
  }
]
```

也可以使用：

```json
{
  "tasks": [
    {
      "task_id": "T-A",
      "start_slice": 0,
      "duration_slices": 4,
      "node_id": "P01-S01",
      "compute_units": 128
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `task_id` | 任务编号 |
| `time` | 可选时间字段，支持 `T03`、`3` 或分钟数形式；会映射到 `start_slice` |
| `start_slice` | 任务开始时间片 |
| `duration_slices` | 任务持续时间片数量 |
| `node_id` | 指定承载任务的卫星节点 |
| `source` | 可选，任务源节点；与 `target` 同时提供时会触发路由计算 |
| `target` | 可选，任务目标节点；与 `source` 同时提供时会使用当前路由算法计算路径 |
| `compute_units` | CPU 计算需求 |
| `gpu_units` | GPU 计算需求 |
| `memory_gb` | 内存需求 |
| `storage_gb` | 存储需求 |
| `traffic_mbps` | 业务流量强度 |
| `priority` | 任务优先级，当前仅保留字段 |
| `task_type` | 任务类型标签，例如 `compute`、`mixed`、`routing`、`telemetry`、`burst` |

上传时会做基础校验：重复 `task_id`、超出时间片范围、空负载任务会给出警告；不存在的 `source`、`target` 或 `node_id` 会阻止数据集生效。

仓库内置了一个标准上传样例：

```text
examples/datasets/stage1-standard-traffic.csv
```

该样例覆盖了跨星路由任务、本地计算任务、遥测/下行业务、突发业务和持续业务，可用于验证“用户数据集能否驱动节点状态与链路状态变化”。它已经被 `npm run audit:stage1` 纳入自动验收。

上传或导出前建议先校验数据集：

```bash
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv
```

校验命令会输出接受任务数、警告、错误、路由任务数、本地任务数、总业务流量和总计算量。`Errors` 必须为 `0`，否则该数据集不应进入第一阶段实验。

导出内置场景模板：

```bash
npm run export:templates
```

模板会生成到 `examples/datasets/templates`，包含空业务、低负载、正常业务、高负载、热点、突发和长时业务 CSV，以及 `manifest.json`。这些 CSV 可以直接上传，也可以复制后修改，用于构造新的可复现实验。

命令行导出上传数据集仿真结果：

```bash
npm run export:scenario -- --tasks examples/datasets/stage1-standard-traffic.csv --out exports/stage1-uploaded
```

## 7. 路由算法

当前系统已经内置一种 Walker 星座常用的基础路由算法：

```text
最短路径路由 shortest-path
```

实现方式：

- 每个时间片先生成当前拓扑中的活跃链路。
- 断开的链路不会进入路由图。
- 对任务的 `source -> target` 使用 Dijkstra 最短路径算法。
- 当前最短路径权重采用链路时延 `latencyMs`。
- 路由结果会记录任务编号、源节点、目标节点、路径、跳数、总距离、总时延和状态。
- 已路由任务的 `traffic_mbps` 会叠加到路径经过的链路利用率上；真实运行模式下，链路利用率只由业务路由、链路承载能力和队列状态驱动。
- 星地遥测下传会单独记入 `downlink_load_mbps`，不会混入业务 `forwarding_load_mbps`。

仪表盘中会显示：

- 当前路由算法：`最短路径`。
- 当前时间片路由成功数量。
- `任务路由` 表格，展示每个任务的路径和可达状态。

当前只提供一个算法选项，但代码中已经将算法抽象为 `RoutingAlgorithm`，后续可以继续加入：

- 负载感知路由。
- 最小时延路由。
- 最小跳数路由。
- 多路径路由。
- 能量感知路由。

## 8. 真值结果导出

仪表盘顶部的 `导出真值` 控件用于导出第一阶段仿真真值。当前支持：

| 导出项 | 文件类型 | 内容 |
| --- | --- | --- |
| 完整 JSON | `.json` | metadata、每个时间片的完整 `NetworkSlice` 和网络指标 |
| 节点 CSV | `.csv` | 每个时间片每颗卫星一行，包含轨道、速度、资源、电量、温度、业务、缓存、遥测状态，以及 CPU/功耗公式贡献分量 |
| 链路 CSV | `.csv` | 每个时间片每条候选链路一行，包含连通状态、断链原因、链路预算、SINR、容量、拥塞和误包率 |
| 路由 CSV | `.csv` | 每个时间片每条任务路由一行，包含源、目的、路径、链路序列、跳数、时延和可达状态 |
| 指标 CSV | `.csv` | 每个时间片一行，汇总全网可用率、任务、队列、转发、下传、遥测和最大拥塞 |

完整 JSON 和命令行导出的 `metadata.json` 会包含 `export_schema_version`、`config_fingerprint`、`dataset_fingerprint` 和 `truth_fingerprint`。其中 `config_fingerprint` 标识仿真参数基线，`dataset_fingerprint` 标识业务输入，`truth_fingerprint` 标识完整时间片真值输出。第二阶段做 INT 遥测复现时，应把采集到的观测数据绑定到同一个 `truth_fingerprint`，再和全知真值层做误差对照。

内置业务模板也会进入 metadata 的业务输入摘要。比如 `normal`、`high-load`、`hotspot` 这类场景会记录自动生成的任务数、总流量、总计算量、内存和存储需求；上传数据集则记录用户文件中的任务摘要。因此无论使用内置场景还是外部数据集，导出的真值文件都有统一的输入标识。

页面中的 `第一阶段真值概览` 面板会对当前仿真的全部时间片做汇总，展示配置指纹、数据集指纹、真值指纹、路由样本、业务任务、动态换路任务、不可用链路误用、约束断链、电池能量范围、CPU/转发负载峰值、链路拥塞峰值和遥测生成/下传量。它用于从仪表盘侧快速判断当前 Walker 网络真值层是否稳定、可解释，并确认当前画面对应哪一个可复现实验基线。

建议实验复现时至少保留：

```text
节点 CSV
链路 CSV
路由 CSV
指标 CSV
```

完整 JSON 包含最完整的真值层，适合归档和第二阶段 INT 对照，但体积较大。当前默认配置下完整 JSON 约为几十 MB，日常分析优先使用 CSV。

命令行批量导出：

```bash
npm run export:scenario -- --profile normal --orbit tle-sgp4 --out exports/normal-tle
```

该命令会在输出目录生成：

```text
metadata.json
nodes.csv
links.csv
routes.csv
metrics.csv
```

如果需要完整时间片真值层，可以追加：

```bash
npm run export:scenario -- --profile high-load --orbit tle-sgp4 --out exports/high-load-tle --full-json
```

如果需要用自己的业务数据集驱动仿真：

```bash
npm run export:scenario -- --tasks data/tasks.csv --out exports/uploaded-run
```

可选参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--profile` | `normal` | 内置业务模式：`empty`、`low-load`、`normal`、`high-load`、`hotspot`、`burst`、`long-duration` |
| `--orbit` | `tle-sgp4` | 轨道模式：`analytic-walker` 或 `tle-sgp4` |
| `--mode` | `operational` | 仿真模式：`autonomous` 或 `operational` |
| `--routing` | `shortest-path` | 当前路由算法 |
| `--tasks` | 空 | CSV/JSON 任务数据集路径；提供后会使用 `uploaded` 业务模式 |
| `--out` | `exports/<profile>-<orbit>` | 导出目录 |
| `--full-json` | 关闭 | 同时导出完整 `truth.json` |

命令行导出和仪表盘下载使用同一套 `NetworkSlice` 与导出函数，因此适合做第一阶段可复现实验，也适合为第二阶段 INT 遥测设计提供“全知真值”对照表。

导出格式审计命令：

```bash
npm run audit:exports
```

该命令会检查节点、链路、路由、指标导出行数是否完整，CSV 表头是否包含关键字段，以及 JSON metadata 和完整时间片是否存在。

## 9. 真实运行模式的计算规则

空数据集情况下：

- CPU 利用率为 `0%`。
- GPU 利用率为 `0%`。
- 任务数量为 `0`。
- 队列深度为 `0`。
- 仍按 `330 W` 标称整星负载和太阳翼发电功率计算电池能量变化。

能量更新采用第一阶物理收支模型：

```text
SoC(t) = E(t) / Ebat,max
E(t + Δt) = clip[
  E(t)
  + ηch × max(Pgen(t) - Pload(t), 0) × Δt
  - max(Pload(t) - Pgen(t), 0) / ηdis × Δt,
  Emin,
  Ebat,max
]
Pgen = S0 × Asa × ηsa × solarExposure
Pload = Pbase + Pcomm + Pcompute + Ppayload + PtaskExtra
```

其中默认值为：

```text
S0 = 1361 W/m²
Asa = 2.0 m²
ηsa = 0.28
ηch = 0.95
ηdis = 0.95
Ebat,max = 1200 Wh
SoCmin = 0.2
Emin = 20% × 1200 Wh = 240 Wh
Pbase + Pcomm + Pcompute + Ppayload = 330 W
```

上传任务后：

- CPU 利用率约等于 `compute_units / cpu_capacity * 100`，再叠加由 ISL 转发流量和队列深度产生的网络开销。
- GPU 利用率约等于 `gpu_units / gpu_capacity * 100`。
- 内存利用率由任务内存、队列元数据和遥测缓冲共同决定。
- 存储利用率由任务存储、业务队列缓存和遥测缓存共同决定。
- `traffic_mbps` 会先进入当前时间片的最短路径路由，并转化为链路需求、实际承载流量、拥塞和丢弃。
- 队列深度由任务数量、未承载流量和链路拥塞共同推动。
- 节点会统计活跃 ISL/SGL 端口数、最大链路占用率、ISL 转发负载、星地下传负载和通信附加功耗。
- 遥测缓存增长由基础上报量、CPU 利用率、节点转发流量和局部链路拥塞共同推动。
- 温度由 CPU 利用率、GPU 利用率和通信附加功耗共同推动。
- 光照面按太阳翼输出和负载功耗的差额充电，充电能量乘以 `ηch`。
- 阴影面 `Pgen = 0`，电池按整星负载和任务附加负载放电，电池侧消耗按 `1 / ηdis` 折算。
- 电量不会下降到 `0%`，当前最低 SoC 为 `20%`。
- 当 SoC 低于或等于 `20%` 时，卫星进入节能模式，不再接收任务；后续充电恢复到阈值以上后才恢复任务接收能力。

当前业务耦合仍保持网络级简化，不做 MAC 退避、逐包重传、FEC 解码或完整协议栈。核心关系为：

```text
CPU_forward = carried_ISL_Gbps × forwardingCpuPercentPerGbps
CPU_queue = queue_GB × queueCpuPercentPerGb

Memory_used =
  task_memory_GB
  + queue_GB × queueMemoryGbPerQueuedGb
  + telemetry_buffer_GB × telemetryMemoryGbPerBufferedGb

Storage_used =
  task_storage_GB
  + cache_GB × cacheStorageGbPerBufferedGb

P_comm_extra =
  active_ISL_links × activeIslLinkPowerW
  + active_SGL_links × activeSglLinkPowerW
  + (carried_ISL_Gbps + downlink_Gbps) × forwardingPowerWPerGbps
  + queue_GB × queuePowerWPerGb

P_load =
  P_base + P_comm + P_compute + P_payload
  + P_task_compute + P_network_compute + P_comm_extra

T_node =
  T_base
  + CPU_percent × thermalRisePerCpuPercent
  + GPU_percent × thermalRisePerGpuPercent
  + P_comm_extra × thermalRisePerCommunicationW

T_gen =
  T_base
  + CPU_percent × k_cpu
  + carried_ISL_Gbps × k_traffic
  + max_congestion_percent × k_congestion
```

其中 `forwarding_load_mbps` 只表示业务在星间链路上的转发负载；遥测通过星地链路下传时会写入 `downlink_load_mbps`。因此空业务下 CPU、GPU、队列、ISL 转发负载和链路业务利用率为 `0`，但仍可能存在基础遥测下传和对应的 SGL 通信功耗。

## 10. 当前仿真程度评估

按默认配置巡检，系统当前生成：

```text
时间片数量：24
每片卫星数：64
每片候选链路数：120
链路可用率范围：85% - 88%
平均链路可用率：86%
空业务真实运行模式最大 CPU：0%
空业务真实运行模式最大 ISL 转发负载：0 Mbps
空业务真实运行模式最低电量：约 54.5% / 654.53 Wh
空业务真实运行模式最低 SoC：0.5454
太阳翼峰值发电：约 762 W
空业务标称负载：330 W
电池侧净功率范围：-347.37 W 到 +410.55 W
节能模式节点数：0
0 电量节点数：0
每颗卫星天线数：4 个 ISL + 1 个 SGL
天线波束超占用数：0
活跃 ISL 链路缺失天线编号数：0
24 个时间片可用星地窗口：103
24 个时间片星地上报容量合计：61800 Mbps
活跃 ISL SNR 范围：55.09 dB - 66.32 dB
活跃 ISL FSPL 范围：262.22 dB - 273.45 dB
可用 SGL SNR 范围：20.03 dB - 25.27 dB
ISL 容量上限：2500 Mbps
SGL 上报容量上限：600 Mbps
任务驱动最大节点转发负载：约 5768 Mbps
任务驱动最大通信附加功耗：约 174 W
任务驱动最大节点链路占用率：100%
```

第一阶段自动验收命令：

```bash
npm run verify:stage1
npm run audit:stage1
npm run audit:exports
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv
npm run export:templates
npm run report:stage1
npm run assess:stage1
npm run baseline:stage1
npm run matrix:stage1
```

推荐优先运行 `npm run verify:stage1`。它会顺序执行生产构建、场景模板导出、仪表盘浏览器审计、标准上传数据集校验、第一阶段成熟度评估和真值导出审计，并生成：

```text
reports/stage1/stage1-verification.json
reports/stage1/stage1-verification.md
reports/stage1/stage1-dashboard-audit.json
reports/stage1/stage1-dashboard-audit.md
```

该命令会运行空业务、低负载、正常业务、高负载、热点、突发和长时业务，并验证以下条件：

- 空业务下 CPU、队列、ISL 转发负载和链路业务利用率保持空闲。
- 空业务下仍存在光照/阴影导致的能量周期变化。
- 低负载业务可路由且不过载。
- 高负载业务比低负载更明显地抬升节点 CPU、链路需求和通信功耗。
- 高负载业务会比低负载更明显地抬升内存、存储、温度和负载功率。
- 热点和突发业务能形成局部压力、队列或拥塞。
- 长时业务能跨多数时间片持续运行。
- 标准上传数据集能通过校验，并驱动路由、节点 CPU、内存、链路需求和 ISL 转发负载变化。
- 空业务不变量会检查没有任务路由、没有任务占用、没有 CPU/GPU 负载、没有业务流量、没有业务队列、没有链路业务需求和链路业务利用率。
- 上传数据集不变量会检查本地计算任务落到指定卫星，跨星路由任务的链路确实存在且承载流量，源/目的/中继节点的业务字段与路径一致，内存和存储占用不会小于任务需求。
- 动态路由不变量会检查所有已路由任务只使用当前时间片的活跃链路，存在极区/链路预算等拓扑约束断链时业务仍可路由，并且持续任务会随时间片拓扑变化产生不同路径。
- 相同配置和相同输入会生成一致结果；审计会比较完整真值指纹，覆盖节点状态、节点资源、链路状态、链路预算摘要、路由路径和路由状态。
- 导出审计会检查节点表、链路表、路由表、指标表和完整 JSON 是否可用于实验复现。

`npm run report:stage1` 会生成第一阶段验收报告：

```text
reports/stage1/stage1-acceptance.json
reports/stage1/stage1-acceptance.md
```

其中 JSON 适合机器读取和归档，Markdown 适合直接查看 7 条合格标准、关键证据和自动检查项。临时验证时可以指定其他输出目录：

```bash
node scripts/auditStageOne.mjs --report-dir .tmp/stage1-report
```

`npm run assess:stage1` 会基于验收结果生成第一阶段模型成熟度评估：

```text
reports/stage1/stage1-model-assessment.json
reports/stage1/stage1-model-assessment.md
reports/stage1/stage1-parameter-baseline.json
reports/stage1/stage1-parameter-baseline.md
reports/stage1/stage1-scenario-matrix.json
reports/stage1/stage1-scenario-matrix.csv
reports/stage1/stage1-scenario-matrix.md
```

该报告用于判断当前模型是否已经适合作为后续 INT 遥测实验的全知真值底座。第一阶段仍然允许仪表盘直接读取节点、链路、路由和遥测缓存真值；第二阶段再把 INT 技术接入进来，用采集到的遥测结果和该真值层进行对照。

`npm run baseline:stage1` 可以单独刷新参数基线报告。它会记录星座、时间片、轨道/拓扑限制、节点资源、电源、业务、队列、天线、链路预算、干扰、多普勒、噪声、天气和地面站参数，并给出 `config_fingerprint`。后续如果修改了任何关键物理或网络参数，应重新生成该基线。

`npm run matrix:stage1` 可以单独刷新场景矩阵报告。它会对比空业务、低负载、正常业务、高负载、热点、突发、长时业务和标准上传数据集，输出每个场景的输入任务量、输入流量、路由样本、CPU、转发负载、链路需求、拥塞、队列、功耗、遥测缓存和真值指纹，用于证明业务数据确实能驱动卫星网络状态响应。

从能力覆盖上看，当前系统大致处在“中等原型仿真”的阶段：

| 模块 | 完善程度 | 说明 |
| --- | --- | --- |
| Walker-Star 拓扑 | 较好 | 轨道面、槽位、轨内/轨间链路、最大链路数、极区限制已经具备 |
| 三维可视化 | 较好 | 地球、轨道面、卫星、链路、旋转、点击节点、快照展示已经具备 |
| 时间片动态 | 中等 | 每个时间片会更新卫星位置、链路状态、节点状态；TLE + SGP4 模式下位置和速度由 SGP4 推出 |
| 轨道传播 | 中等 | 已支持解析 Walker 与合成 TLE + SGP4 双模式，包含 ECI/ECEF、经纬度、高度、速度和地球自转参考系；尚未接入真实公开 TLE 历史数据 |
| 链路建模 | 中等偏上 | 有距离阈值、极区断链、地球遮挡、天线最大距离、FSPL、接收功率、环境噪声、太阳规避角/太阳干扰损耗、SNR、SINR、ISL/SGL 频率复用、同频/邻频干扰聚合、SGL 仰角/动态天气衰减、动态指向损耗、切换时延/可用比例、多普勒频移/补偿残差、自适应 MCS、BER/PER、有效容量、时延和带宽状态，但仍缺标准级物理层帧/译码和高保真天气场 |
| 天线/星地窗口 | 中等偏上 | 每星具备 4 个 ISL 方向天线和 1 个 SGL 地向天线，支持天线占用、仰角门限、距离门限、地面站天气约束、上报容量、上一时间片指向历史、切换时延和动态指向损耗 |
| 节点资源建模 | 中等偏上原型 | 支持 CPU/GPU/内存/存储/电量 Wh/SoC/节能模式/队列/温度/活跃端口/ISL 转发负载/SGL 下传负载/通信附加功耗；内存、存储、温度和能量已由任务、缓存、通信功耗、转发 CPU、太阳翼、电池和效率参数共同驱动，并导出计算 CPU、业务流量 CPU、转发 CPU、队列 CPU、任务计算功耗和网络计算功耗等贡献分量，但参数仍是工程假设 |
| 业务流量建模 | 中等偏上原型 | 支持空业务、低负载、正常业务、高负载、热点、突发、长时业务和上传任务；source/target 会经最短路径路由，流量会驱动链路利用率、链路拥塞、时间片级队列、丢弃、节点缓存、转发 CPU、通信功耗和遥测生成量 |
| 电源/光照建模 | 中等原型 | 采用太阳常数、太阳翼面积/效率、电池容量、充放电效率、SoC 阈值和负载功耗计算能量收支；太阳方向已由当前仿真时间的 ECI 太阳向量统一驱动，但姿态、太阳翼指向、热控和电池老化仍简化 |
| 遥测与全网感知 | 中等偏上原型 | 可展示节点和链路状态，并按时间片生成、缓存和下传遥测；已支持节点/链路/路由/指标/完整 JSON 真值导出，仍缺真实遥测日志回放和异常事件注入 |

综合判断：

```text
拓扑展示与教学演示：约 70% 完成
Walker 星座结构原型：约 60% 完成
资源/任务仿真原型：约 40% 完成
真实卫星网络高保真仿真：约 30% 完成
```

也就是说，它已经是一个可运行、可展示、可扩展的 Walker LEO 网络仿真仪表盘；轨道传播已经从纯解析模型迈入 TLE/SGP4 原型阶段，但距离真实卫星网络仿真还需要补上真实星历源、通信、业务和遥测四类核心能力。

## 11. 当前已知边界

当前系统尚未实现：

- 真实 TLE 数据导入和历史星历回放。
- SDP4、J2/J4 显式摄动和高精度星历误差模型。
- 真实 Starlink/NORAD/COSPAR 卫星目录映射。
- 多壳层星座。
- 用户终端、HAPS 节点参与网络。
- 高级路由算法切换，如负载感知、多路径和能量感知路由。
- 完整网络协议栈，如 TCP/QUIC 拥塞控制、重传、分片、协议头开销和多路径调度。
- 精确排队时延模型、业务优先级调度和细粒度包级丢包。
- 高保真闭环姿态控制、真实波束调度、标准级 LDPC/BCH 译码、真实重传协议、真实天气栅格和完整频谱掩模。
- 姿态控制、太阳翼指向角、热控、电池充放电效率和更细粒度的真实功耗曲线。
- 遥测数据回放、异常事件注入。

## 12. 建议下一步路线

如果目标是更接近真实 Walker 星座，建议按下面顺序推进：

1. 接入真实 TLE 数据源或用户上传 TLE 文件，并把当前合成 TLE 目录替换为真实星历目录。
2. 增加多壳层配置，支持不同高度、倾角和轨道面数量。
3. 增加地面站和用户终端，计算可见卫星集合和接入窗口。
4. 在现有最短路径路由基础上，增加负载感知、能量感知和多路径路由。
5. 在现有链路预算、SINR 干扰、SGL 天气衰减、天线指向/切换和 MCS/PER 模型上增加真实天气数据接入、标准级物理层帧/译码和真实链路重传。
6. 增加遥测事件流，支持外部 CSV/JSON 回放节点状态和链路状态。
7. 增加异常事件注入，包括节点故障、链路故障、地面站下传受限和任务突发异常。
8. 为仿真核心增加单元测试，保证链路断开规则、极区限制、能量模型和任务负载计算稳定。

## 13. 常见问题

### 为什么空业务下 CPU 是 0？

真实运行模式表示“由业务任务驱动资源消耗”。如果没有任务输入，CPU/GPU/队列/ISL 转发负载和链路业务利用率都应该为 0。自主模拟模式仍会生成周期性 CPU 与链路利用率波动，用于展示状态监测效果。基础遥测仍可能通过星地链路下传，因此 `downlink_load_mbps` 和少量 SGL 通信功耗可以不为 0。

### 为什么电量不会变成 0？

当前模型设置了最低 SoC `20%`，对应 `240 Wh` 的保底能量。这更符合仿真演示中“卫星进入安全保底状态”的设定，避免大量节点因为简化功耗模型直接掉到 0。SoC 低于或等于该阈值时，节点会进入节能模式并暂停接收任务。

### 任务是否已经沿链路路由？

已经支持基础路由。任务同时提供 `source` 和 `target` 时，系统会在当前时间片的活跃链路上使用 Dijkstra 最短路径算法计算路径，并把 `traffic_mbps` 叠加到经过链路的利用率上。链路承载能力不足时，会形成拥塞、丢弃和时间片队列；经过链路两端的卫星也会产生 ISL 转发负载、活跃端口占用、通信附加功耗和额外遥测生成量。

但它仍不是完整网络协议栈仿真：当前没有实现 TCP/QUIC 拥塞控制、精确排队时延、逐包重传、分片、传输层协议或多路径调度。

### 链路为什么会断开？

轨间链路可能因为三种原因断开：

- 距离超过阈值。
- 卫星进入极地区域。
- 地球遮挡导致不可视。
- 超过天线最大通信距离。
- 天线目标切换在当前时间片内无法满足最低可用比例。
- 多普勒频移超过接收机补偿范围，或补偿残差超过残差门限。
- 链路预算或有效容量低于门限。
- 激光 ISL 接收波束进入太阳规避角，触发 `solar-interference` 断链。

轨内链路当前作为稳定候选链路处理，但仍会经过天线范围、链路预算、指向损耗、太阳规避角、可用比例和容量门限检查。
