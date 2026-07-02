# INT-MC 对齐说明

本文档说明本项目第二阶段的原生 INT 全网感知实现，如何与 INT-MC 原型中的 INT 数据采集部分对齐，方便后续做公平对比。

## 对齐目标

本项目不追求把 INT-MC 的 Mininet/P4 原型逐行搬到卫星网络里，而是把其中的 INT 测量逻辑抽象成可比较的实验接口：

- 一条被选中的业务路径或 probe 路径对应一个 INT packet/probe；
- 路径上的每一跳卫星对应一条 INT hop record；
- 每条 hop record 记录本节点、本跳链路和队列状态；
- sink 节点生成 report；
- Ground OAM 只使用成功下传的 report 重构网络状态；
- 第一阶段真值只用于实验后检验，不参与 INT 运行时重构。

因此，后续比较的是遥测记录级和实验指标级效果，不是 P4 二进制报文格式级效果。

## INT-MC 原型中的 INT 部分

根据 `E:\INT-MC-main\INT-MC-main` 中的源码，INT-MC 的 INT 部分主要包含：

- 源路由头：指定 INT packet 经过哪些 switch；
- P4 egress 插入：每个交换机在 egress 阶段压入 INT metadata；
- hop metadata 字段：`switch_id`、`output_port`、`queue_depth`、`queue_latency`、`hop_latency` 等；
- 接收端解析：collector/sniffer 解析 INT metadata，得到逐跳测量记录；
- 矩阵补全：后续算法使用部分测量到的链路状态，推断未测量链路状态。

## 本项目中的对应关系

| INT-MC 字段或机制 | 本项目字段或机制 | 对齐状态 | 说明 |
|---|---|---|---|
| source route stack | `probe-paths-*.csv` 中的 `path` / `link_ids` | 直接对齐 | 本项目用 CSV 路径表达源路由，不模拟 wire header。 |
| `switch_id` | `node_id` | 直接对齐 | 卫星节点作为逻辑交换节点。 |
| `output_port` | `egress_link_id` / `local_port_peer` | 逻辑对齐 | 本项目使用逻辑链路 ID，不使用 P4 数字端口。 |
| `queue_depth` | `observed_queue_depth` | 直接对齐 | 单位是仿真队列深度，不是硬件队列单位。 |
| `queue_latency` | `observed_link_queue_latency_ms` | 直接对齐 | 使用时间片级队列排空近似：`queued_traffic_mb * 8 * 1000 / effective_capacity_mbps`。 |
| `hop_latency` | `observed_link_latency_ms` | 模型级对齐 | 表示链路级总时延估计，不是硬件时间戳差。 |
| `pkts/txbytes` | `carried_traffic_mbps` / `demand_traffic_mbps` / `report_size_bytes` | 部分对齐 | 本项目是时间片级、流级仿真，不做逐包计数。 |
| INT report | `int-reports.csv`、`probe-int-reports-*.csv`、`ground-delivered-reports.csv` | 直接对齐 | 表示 sink 生成并回传给 Ground OAM 的遥测报告。 |

## 显式队列时延字段

为了避免继续用 `queued_traffic_mb` 作为 `queue_latency` 的 proxy，本项目已经在 hop metadata 和 OAM 重构中加入显式字段：

```text
observed_link_queue_latency_ms
observed_link_propagation_latency_ms
observed_link_queue_latency_formula
queue_latency_ms_estimate
```

其中：

```text
observed_link_queue_latency_ms = queued_traffic_mb * 8 * 1000 / effective_capacity_mbps
```

该字段不是逐包硬件队列时间戳，而是卫星网络时间片仿真里的队列排空时延估计。它适合用于算法级比较、OAM 状态重构和 INT-MC 矩阵补全误差评估。

## 统一比较约束

后续实验中，原生 INT、卫星化 INT-MC、改进型 INT-MC 应统一以下条件：

- 使用同一份第一阶段真值快照；
- 使用同一业务数据集；
- 使用同一时间片范围；
- 使用同一轨道模型和链路状态；
- 使用同一 `hop_metadata_bytes` 和 `report_header_bytes`；
- 使用同一 Ground OAM 下传预算；
- 未观测对象保持 `unknown` 或 `inferred`，不能用真值补齐。

## 推荐比较指标

核心指标包括：

- `hop_records`
- `total_metadata_bytes`
- `total_report_bytes`
- `total_int_bytes`
- `node_sample_coverage`
- `link_sample_coverage`
- `active_link_sample_coverage`
- `direct_observation_rate_on_active`
- `inferred_rate_on_active`
- `queue_latency_mae_ms`
- `MAE/RMSE/NMSE`
- `delta_task_latency_ms`
- `delta_delivery_ratio`

## 自动审计命令

```powershell
npm run int:align -- --run stage2-int/runs/<run-name>
```

如果 INT-MC 源码不在默认路径，可以指定：

```powershell
npm run int:align -- --run stage2-int/runs/<run-name> --int-mc-root E:\INT-MC-main\INT-MC-main
```

输出目录：

```text
stage2-int/runs/<run-name>/int-mc-alignment/
  int-mc-alignment-report.json
  int-mc-alignment-report.md
  probe-int-mc-comparable-hops-<algorithm>.csv
  traffic-int-mc-comparable-hops.csv
```

## 当前边界

当前项目适合做算法级、遥测记录级和状态重构级对比；暂不适合直接做 P4 wire-level 或 Tofino hardware-level 对比。

如果后续论文需要强调 P4 级复现，则应额外补充：

- 二进制 INT header 定义；
- numeric output port 映射；
- packet counter / txbytes；
- 硬件级 per-hop queue timestamp；
- parser/deparser 或 ns-3/P4 行为验证。

就本项目目标而言，也就是面向动态 LEO 卫星网络的低开销全网状态感知与 INT-MC 改进，当前对齐层级已经足够支撑后续对比实验。
