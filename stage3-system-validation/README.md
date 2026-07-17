# 实验 13：经济型包级系统交叉验证

本目录用于给现有聚合级卫星网络仿真增加一层小规模、独立的包级交叉验证。目标不是用 ns-3 重做整个项目，而是检查几个最容易被审稿人质疑的系统效应：

- INT metadata 是否按跳增长并触发真实的 MTU 约束；
- 遥测包与业务包是否在同一链路队列中竞争；
- 动态链路、误包率和队列是否会造成 probe/report 丢失；
- 选择性 metadata 相比全量 metadata 是否在相同路径和频率下减少计划字节并提高 report 交付率；
- 聚合仿真给出的趋势能否在独立包级实现中复现。

## 为什么这个设计比较经济

实验只使用 Iridium NEXT 66 星的 20 个时间片，并复用已经生成的第一阶段真值和第二阶段 probe plan。它不重跑轨道传播、完整 INT 实验或矩阵补全。

核心比较 9 个组合，并增加 3 个不计入核心平均值的定向压力扩展：

```text
3 个业务负载 x 3 个方案
负载：0.6、1.0、1.4
方案：no-int、full-int、leo-selective
定向压力扩展：2.0 x 上述 3 个方案
```

`full-int` 与 `leo-selective` 使用完全相同的物理 probe 路径、发送起止时间和 50 ms 发送间隔。唯一自变量是逐跳 metadata：

- `full-int`：每个物理跳写入 96 B；
- `leo-selective`：沿用增强算法导出的 full/compact/forward-only 决策；
- 适配器补入的物理中继跳在选择性方案中为 forward-only。

这避免把“路径更短”误算成“metadata 策略更好”。

## 目录

```text
stage3-system-validation/
├── fixtures/iridium-66-20slice/       冻结的独立输入
├── ns3/scratch/leo-int-system-validation.cc
├── ns3/run-ns3.sh
└── README.md
```

生成结果位于：

```text
reports/experiment13-system-validation/
├── reference-packet-results.csv
├── reference-packet-results.json
├── ns3/ns3-result-*.csv
├── ns3/ns3-status.json
├── experiment13-system-validation-summary.json
├── EXPERIMENT_13_SYSTEM_VALIDATION.md
└── index.html
```

## 本地运行

只重新导出冻结输入：

```bash
npm run experiment13:export
```

运行独立 JavaScript 包级参考回放：

```bash
npm run experiment13:reference
```

参考回放用于检查适配器与趋势，不能写成 ns-3 或系统级证据。

运行 ns-3：

```bash
export NS3_ROOT=/path/to/ns-3.44
npm run experiment13:ns3
npm run experiment13:report
```

Windows 推荐在 WSL2 中执行。ns-3 官方也支持完整 MSYS2/MinGW64 环境，但不支持 MSVC。官方安装说明：<https://www.nsnam.org/docs/release/3.44/installation/html/windows.html>。

仓库提供了 WSL2 专用安装和运行入口：

```powershell
# Windows 重启后完成 Debian/ns-3 安装
powershell -ExecutionPolicy Bypass -File stage3-system-validation/ns3/finish-wsl-ns3.ps1

# 在 WSL2 中运行 9 组核心实验和 3 组压力扩展，并回写 Windows 报告
npm run experiment13:ns3:wsl
```

本机没有 ns-3 时，可在 GitHub 仓库的 Actions 页面手动运行 `Experiment 13 ns-3 microvalidation`。工作流会下载固定版本 ns-3.44、编译单个 scratch 程序、运行 9 个核心组合与 3 个压力扩展组合并上传报告，不占用本地 16 GB 内存。

## 输入适配

适配器读取以下既有工件：

- 第一阶段 `nodes.csv`、`links.csv`、`routes.csv`；
- 第二阶段增强方案 `probe-paths-int-mc.csv`。

少数导出的 probe waypoint 之间不是直接物理邻居。适配器会在该时间片的活动图上用最短活动路径展开这个逻辑段，并记录：

- `adapter_path_repair_count`；
- `adapter_inserted_transit_hops`；
- `original_path_nodes`；
- 展开后的 `path_nodes`。

任何无法展开的业务或 probe 都进入 `rejected-records.csv`，不会被静默接受。

## 主要指标

| 指标 | 含义 |
|---|---|
| `planned_telemetry_network_bytes` | 假设 probe 和 report 完整走完路径时需要的链路字节，是跨方案开销主口径 |
| `telemetry_network_bytes` | 实际进入链路发送的遥测字节 |
| `report_delivery_ratio` | 返回源端/Ground OAM 的报告数除以发送 probe 数 |
| `business_delay_p95_ms` | 成功业务包端到端时延 P95 |
| `business_throughput_mbps` | 成功交付的业务 payload 吞吐 |
| `queue_delay_p95_ms` | 由 ns-3 设备队列 Enqueue/Dequeue 事件测得的全部数据包排队等待 P95 |
| `business_queue_delay_p95_ms` | 业务数据包的设备队列等待 P95 |
| `telemetry_queue_delay_p95_ms` | probe 与 report 数据包的设备队列等待 P95 |
| `mtu_drop_packets` | INT 包增长超过 1500 B 后被丢弃的次数 |
| `device_queue_drop_packets` | ns-3 PointToPointNetDevice 队列丢弃数 |
| `report_rtt_p95_ms` | 成功返回 Ground OAM 的 report 往返时延 P95 |
| `oam_time_average_aoi_ms` | Ground OAM 对各 probe 状态的时间平均信息年龄（AoI） |
| `oam_peak_aoi_p95_ms` | Ground OAM 在实验窗口内各 probe 峰值 AoI 的 P95 |
| `useful_reports_per_planned_telemetry_mb` | 每 MB 计划遥测链路字节带来的成功报告数，避免 MTU 提前丢弃造成幸存者偏差 |

必须同时解释计划字节、实际字节和 report 交付率。若全量 INT 包在路径前半段就因 MTU 丢弃，它的“实际发送字节”反而可能更小，这是幸存者偏差，不代表开销更低。

## 证据门禁

报告只在 3 个核心负载和 3 个方案全部生成 ns-3 CSV 后标记为：

```text
ns3-system-cross-validation-complete
```

否则分别标记为 partial 或：

```text
adapter-ready-reference-only-not-system-evidence
```

2.0 倍负载的 3 个压力扩展组合单独报告完成度与结果，不并入核心平均收益，也不用于放宽上述证据门禁。

即使完整运行，实验仍只支持“包级系统趋势得到独立交叉验证”，不能声称复刻真实 Iridium/Starlink 硬件、操作系统或在轨 P4 数据面。
