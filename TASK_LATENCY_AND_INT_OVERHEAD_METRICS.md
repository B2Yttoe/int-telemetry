# 任务时延与 INT 开销指标说明

本文说明当前项目中新增的任务级时延数据，以及后续评估 INT / INT-MC 遥测开销时建议采用的指标口径。

## 1. 任务时延数据

第一阶段导出现在会在 `routes.csv` 和 `task-traces.csv` 中记录任务级时延与交付状态。

典型位置：

```text
exports/<scenario>/routes.csv
exports/<scenario>/task-traces.csv
stage2-int/runs/<run>/stage1-truth/routes.csv
stage2-int/runs/<run>/stage1-truth/task-traces.csv
```

### 1.1 核心字段

| 字段 | 含义 |
|---|---|
| `latency_ms` | 兼容旧字段，表示当前路径基础时延。 |
| `route_latency_ms` | 路径传播/链路基础时延，由当前任务路径上的链路时延汇总得到。 |
| `queue_delay_ms` | 根据任务在当前时间片的排队量和承载速率估算的排队等待时延。 |
| `estimated_end_to_end_latency_ms` | 当前任务估计端到端时延，计算为 `route_latency_ms + queue_delay_ms`。 |
| `delivery_ratio` | 当前时间片任务需求流量中被实际承载的比例，范围为 `0` 到 `1`。 |
| `delivery_state` | 当前任务交付状态，例如 `delivered`、`queued`、`partial-queued`、`partial-with-drop`、`dropped`、`unroutable`、`local-compute`。 |
| `delivered` | 当前时间片任务是否被视为成功交付或本地完成。 |
| `dropped` | 当前时间片该任务是否发生丢弃。 |
| `latency_model` | 时延估计模型，目前为 `route_latency_plus_queue_delay`。 |

### 1.2 当前模型边界

当前项目不做逐包仿真，因此任务时延是流级/时间片级估计值：

```text
estimated_end_to_end_latency_ms
  = route_latency_ms + queue_delay_ms
```

其中 `queue_delay_ms` 使用当前时间片内该任务的排队量和服务速率估计，不模拟 TCP 重传、逐包排队、MAC 退避或 FEC 编解码过程。

这个抽象适合当前目标：生成每个时间片的卫星节点、链路、任务性能真值，用于 INT 遥测复现、INT-MC 重构和后续机器学习预测。

## 2. INT 开销指标

评估 INT 带来的开销时，不建议只看一个总字节比例。建议拆成带宽开销、路径开销、报告回传开销、节点处理开销、缓存开销和业务影响开销。

### 2.1 带宽开销

```text
probe_packet_count = generated_probe_packets
probe_hop_count = sum(probe_path_hops)
metadata_bytes = sum(hop_records * bytes_per_hop_metadata)
report_bytes = sum(report_size_bytes)
control_bytes = probe_packet_bytes + metadata_bytes + report_bytes
business_bytes = sum(carried_business_mbps * slice_seconds / 8)
bandwidth_overhead_ratio = control_bytes / max(business_bytes, 1)
```

建议报告：

| 指标 | 含义 |
|---|---|
| `probe_packet_count` | 生成的主动探测包数量。 |
| `probe_hop_count` | 所有 probe 路径经过的跳数总和。 |
| `metadata_bytes` | INT metadata 总字节数。 |
| `report_bytes` | Ground OAM 报告总字节数。 |
| `bandwidth_overhead_ratio` | INT 控制/遥测字节相对业务承载字节的比例。 |
| `link_overhead_ratio` | 单链路上的 INT 字节相对业务字节比例。 |

### 2.2 路径与冗余开销

```text
mean_probe_path_hops
max_probe_path_hops
path_length_std
duplicate_link_collection_count
duplicate_link_collection_ratio
```

这些指标用于回答：为了覆盖全网，INT probe 是否绕了过长路径，是否重复测了同一批链路。

### 2.3 星地回传开销

```text
generated_reports
delivered_reports
queued_or_dropped_reports
delivery_ratio
mean_reporting_latency_ms
mean_delivery_delay_slices
reporting_blocked_paths
```

这些指标用于评价遥测结果能否及时回到 Ground OAM。卫星网络里，星地窗口和下传容量是关键瓶颈，因此 `report_bytes` 和 `delivery_delay_slices` 很重要。

### 2.4 节点处理与缓存开销

```text
int_hop_records_per_node
node_processing_overhead = int_hop_records_per_node * per_record_processing_cost
telemetry_storage_overhead = generated_reports_bytes + queued_reports_bytes
telemetry_buffer_mb
telemetry_dropped_mb
```

当前项目不做硬件级 P4/ASIC 处理时延仿真，因此建议把节点处理开销作为相对指标：同一组场景下比较 `traffic-int`、`probe-int`、`int-mc` 的 hop record 数量和缓存占用。

### 2.5 业务影响开销

业务影响比 INT 自身字节数更能说明遥测是否“打扰了网络”。建议和 no-INT baseline 对比：

```text
delta_task_latency_ms = latency_with_int - latency_without_int
delta_queue_mb = queue_with_int - queue_without_int
delta_drop_mb = drop_with_int - drop_without_int
delta_delivery_ratio = delivery_ratio_with_int - delivery_ratio_without_int
```

建议报告：

| 指标 | 含义 |
|---|---|
| `mean_delta_task_latency_ms` | INT 引入后的平均任务时延变化。 |
| `p95_delta_task_latency_ms` | INT 引入后的 P95 任务时延变化。 |
| `delta_total_queue_mb` | 全网排队量变化。 |
| `delta_total_drop_mb` | 全网丢弃量变化。 |
| `delta_delivery_ratio` | 任务交付率变化。 |

## 3. 推荐实验对比

建议至少包含以下组：

```text
no-int baseline
traffic-int
probe-int path-balance
probe-int int-mc
```

每组都报告：

```text
覆盖率：node/link/active-link coverage
准确率：CPU、队列、链路利用率、容量、时延 MAE
开销：metadata/report/probe bytes、overhead ratio、probe hop count
时效：reporting latency、delivery delay slices
业务影响：task latency、queue、drop、delivery ratio
```

这样可以证明 INT-MC 的价值不是“测得更多”，而是在相近全网重构精度下，用更少的 probe、hop、metadata、report 和业务扰动完成遥测。
