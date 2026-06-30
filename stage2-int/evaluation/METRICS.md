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
