# Stage 2 INT Evaluation Metrics

第二阶段评估必须区分：

- INT 观测值：来自成功采集并回传的 hop records / reports。
- 第一阶段真值：只在评估阶段读取。

## 1. 覆盖率

```text
node_coverage = observed_nodes / truth_nodes
active_link_coverage = observed_active_links / truth_active_links
route_coverage = sampled_routed_routes / truth_routed_routes
slice_coverage = slices_with_reports / truth_slices
```

对于 probe-int 全网感知实验，还需要统计全部候选链路：

```text
link_sample_coverage = observed_links / truth_links
```

这里的 `truth_links` 是第一阶段 `links.csv` 中导出的所有链路样本，包括 active 链路和当前断开的候选链路。断链不能作为转发路径经过，但可以通过端点卫星的本地端口/邻接链路状态进入 INT 报告。

## 2. 开销

```text
probe_count
probe_hop_count
int_metadata_bytes
report_bytes
overhead_ratio = int_metadata_bytes / carried_business_bytes
duplicate_link_collection_count
```

建议后续论文实验将 INT 开销拆成以下几类，而不是只用单一 `overhead_ratio`：

```text
probe_packet_count = generated_probe_packets
probe_hop_count = sum(probe_path_hops)
metadata_bytes = sum(hop_records * bytes_per_hop_metadata)
report_bytes = sum(report_size_bytes)
control_bytes = probe_packet_bytes + metadata_bytes + report_bytes
business_bytes = sum(carried_business_mbps * slice_seconds / 8)
bandwidth_overhead_ratio = control_bytes / max(business_bytes, 1)
link_overhead_ratio = per_link_int_bytes / max(per_link_business_bytes, 1)
node_processing_overhead = int_hop_records_per_node * per_record_processing_cost
node_telemetry_energy = per_node_processing_energy + per_node_tx_energy
sgl_downlink_report_bytes = bytes sent by the final satellite toward Ground OAM
telemetry_storage_overhead = generated_reports_bytes + queued_reports_bytes
```

其中：

- `bandwidth_overhead_ratio`：最核心，表示 INT probe、metadata 和 report 占业务承载量的比例。
- `probe_hop_count`：反映 INT 在星间链路上实际穿越了多少跳，比单纯 probe 数量更能代表网络负担。
- `report_bytes`：反映 Ground OAM 回传压力，尤其适合评估星地回传窗口受限时的开销。
- `duplicate_link_collection_count`：同一时间片同一链路被重复测量的次数，越高说明采样路径冗余越大。
- `node_telemetry_energy`：反映每颗卫星为了遥测额外消耗的处理和发送能量，适合分析低电量、阴影区和节能模式下的遥测调度是否合理。
- `sgl_downlink_report_bytes`：反映最终星地回传压力，适合和地面站窗口、report 优先级、遥测缓存联合分析。
- `telemetry_storage_overhead`：反映卫星缓存压力，适合和 `telemetry_buffer_mb`、`telemetry_dropped_mb` 联合分析。
- `business_impact`：建议用业务端到端时延、队列和丢弃变化刻画，而不是只看 INT 自身字节数。

建议至少做三组对比：

```text
no-int baseline
traffic-int
probe-int / int-mc
```

业务影响指标建议为：

```text
delta_task_latency_ms = latency_with_int - latency_without_int
delta_queue_mb = queue_with_int - queue_without_int
delta_drop_mb = drop_with_int - drop_without_int
delta_delivery_ratio = delivery_ratio_with_int - delivery_ratio_without_int
```

在当前项目抽象层级下，INT 开销不需要逐包仿真；可以按时间片汇总 probe path、hop record、report size 和业务承载字节来估算。

## 3. 时效性

```text
telemetry_time
ground_delivery_delay_slices
max_reporting_path_hops
mean_reporting_path_hops
```

论文重点指标：

- telemetry time
- longest path length
- path length standard deviation

地面 OAM 重构还记录：

```text
generated_reports
delivered_reports
queued_or_dropped_reports
delivery_ratio
mean_delivery_delay_slices
```

## 4. 均衡性

```text
path_length_min
path_length_max
path_length_mean
path_length_std
balance_score = 1 / (1 + path_length_std)
```

## 5. 重构误差

只对被观测到的对象计算误差：

```text
cpu_mae
queue_mae
link_utilization_mae
latency_mae
capacity_mae
```

分类指标：

```text
congestion_precision
congestion_recall
node_health_accuracy
link_down_detection_delay
```

## 6. Unknown 处理

未观测对象必须保留 unknown：

```text
observed = false
state = unknown
confidence = 0
```

不允许用第一阶段真值填充 unknown。

## 7. 当前工具输出

`tools/ground-oam-reconstructor.mjs` 输出：

```text
ground-delivered-reports.csv
ground-undelivered-reports.csv
ground-reconstructed-nodes.csv
ground-reconstructed-links.csv
ground-oam-evaluation.json
```

其中 `ground-oam-evaluation.json` 的 `boundary` 字段必须包含：

```json
{
  "runtime_uses_only_delivered_int_reports": true,
  "truth_used_only_for_evaluation": true,
  "unknown_not_filled_from_truth": true
}
```

这是第二阶段区别于第一阶段全知仪表盘的关键约束。

## 8. 全网逐时间步审计

`tools/audit-full-telemetry-coverage.mjs` 用于验证 probe-int 是否满足“每个时间步都捕获全网节点和链路状态”：

```bash
node stage2-int/tools/audit-full-telemetry-coverage.mjs --input exports/tmp-highload-check --ground stage2-int/outputs/tmp-highload-check/ground-probe-path-balance
```

通过条件：

```text
每个 slice_index:
  node_sample_coverage = 1
  link_sample_coverage = 1
```

当前高负载样例审计结果：

```text
slices = 24
passed_slices = 24
failed_slices = 0
node_sample_coverage = 1
link_sample_coverage = 1
pass = true
```
