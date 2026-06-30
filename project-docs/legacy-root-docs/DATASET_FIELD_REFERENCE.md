# 数据集字段说明

本文档说明项目中主要输入/输出数据集的字段含义，覆盖业务输入、第一阶段卫星网络真值、第二阶段 INT 遥测过程和 Ground OAM 重构结果。

## 1. 业务输入数据集

典型文件：

```text
examples/datasets/stage1-standard-traffic.csv
examples/datasets/real-starlink-72x22-ml-48-traffic.csv
examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv
```

表头：

```csv
task_id,time,start_slice,duration_slices,source,target,node_id,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type
```

| 字段 | 含义 |
|---|---|
| `task_id` | 任务唯一编号，用于在路由、节点影响、链路影响和 INT 报告中追踪同一业务。 |
| `time` | 任务开始时间片的可读标签，例如 `T00`、`T18`。 |
| `start_slice` | 任务开始时间片编号，从 `0` 开始。 |
| `duration_slices` | 任务持续的时间片数量。 |
| `source` | 跨星路由任务的源卫星节点，例如 `P07-S03`。 |
| `target` | 跨星路由任务的目标卫星节点。 |
| `node_id` | 本地计算任务所在卫星。跨星路由任务通常为空。 |
| `compute_units` | 任务计算需求，用于驱动 CPU、计算功耗和任务参与状态。 |
| `gpu_units` | GPU 需求，可为 `0`。用于表达更重的计算/AI 类任务。 |
| `memory_gb` | 任务内存需求，单位 GB。 |
| `storage_gb` | 任务存储需求，单位 GB。 |
| `traffic_mbps` | 跨星业务流量需求，单位 Mbps。会进入路由、链路利用率、队列、拥塞和丢弃计算。 |
| `priority` | 任务优先级。数值越高，拥塞分配时越偏向保留承载。 |
| `task_type` | 任务类型，例如 `compute`、`routing`、`downlink`、`telemetry`、`mixed`、`background`、`burst`。 |

填写规则：

- 有 `source` 和 `target`，表示跨星路由任务。
- 有 `node_id`，表示本地计算任务。
- 跨星路由任务不要填写 `node_id`。
- 本地计算任务不要填写 `source` 或 `target`。
- `traffic_mbps > 0` 时必须提供合法的 `source` 和 `target`。
- `source` 和 `target` 不能相同。

## 2. 第一阶段真值数据集

典型目录：

```text
exports/<scenario>/
stage2-int/runs/<run>/stage1-truth/
```

这些文件是第一阶段模型的全知真值，用于模型分析、机器学习训练标签和第二阶段 INT 准确率检验。

### 2.1 `nodes.csv`

每个时间片下每颗卫星节点的真值状态。

| 字段 | 含义 |
|---|---|
| `slice_index` | 时间片编号。 |
| `time` | 当前仿真时间。 |
| `minute` | 当前仿真分钟。 |
| `node_id` | 卫星节点编号。 |
| `label` | 节点显示标签。 |
| `plane` | 所属轨道面编号。 |
| `slot` | 轨道面内槽位编号。 |
| `mode` | 节点运行模式，例如正常、告警、退化或节能。 |
| `latitude_deg` | 星下点纬度，单位度。 |
| `longitude_deg` | 星下点经度，单位度。 |
| `altitude_km` | 当前高度，单位 km。 |
| `x_eci_km`, `y_eci_km`, `z_eci_km` | ECI 坐标，单位 km。 |
| `vx_km_s`, `vy_km_s`, `vz_km_s` | ECI 速度向量，单位 km/s。 |
| `in_sunlight` | 是否处于光照区。 |
| `solar_exposure` | 光照暴露系数，用于太阳能发电计算。 |
| `cpu_percent` | 节点总 CPU 利用率。 |
| `gpu_percent` | 节点 GPU 利用率。 |
| `memory_percent` | 内存占用百分比。 |
| `storage_percent` | 存储占用百分比。 |
| `memory_used_gb` | 已使用内存，单位 GB。 |
| `storage_used_gb` | 已使用存储，单位 GB。 |
| `temperature_c` | 节点温度，单位摄氏度。 |
| `queue_depth` | 节点业务队列深度。 |
| `energy_percent` | 电量百分比。 |
| `energy_wh` | 电池当前能量，单位 Wh。 |
| `state_of_charge` | 电池荷电状态，通常为 0 到 1。 |
| `solar_power_w` | 当前太阳能发电功率，单位 W。 |
| `load_power_w` | 当前总负载功率，单位 W。 |
| `net_power_w` | 净功率，正值表示充电，负值表示放电。 |
| `power_saving_mode` | 是否进入节能模式。 |
| `can_accept_tasks` | 当前是否可以接收或参与业务任务。 |
| `compute_cpu_percent` | 本地计算任务造成的 CPU 占用。 |
| `task_traffic_cpu_percent` | 业务流量处理造成的 CPU 占用。 |
| `forwarding_cpu_percent` | 转发业务造成的 CPU 占用。 |
| `queue_cpu_percent` | 排队压力造成的 CPU 占用。 |
| `base_power_w` | 基础平台功耗，单位 W。 |
| `payload_power_w` | 载荷功耗，单位 W。 |
| `task_compute_power_w` | 任务计算功耗，单位 W。 |
| `network_compute_power_w` | 网络转发/通信相关计算功耗，单位 W。 |
| `assigned_task_count` | 当前分配到该节点的任务数量。 |
| `workload_cpu_percent` | 工作负载 CPU 占用。 |
| `workload_gpu_percent` | 工作负载 GPU 占用。 |
| `workload_memory_gb` | 工作负载内存需求，单位 GB。 |
| `workload_storage_gb` | 工作负载存储需求，单位 GB。 |
| `ingress_traffic_mbps` | 进入该节点的业务流量。 |
| `egress_traffic_mbps` | 从该节点发出的业务流量。 |
| `transit_traffic_mbps` | 经过该节点中继转发的业务流量。 |
| `forwarding_load_mbps` | 节点转发负载。 |
| `downlink_load_mbps` | 星地下行负载。 |
| `active_isl_links` | 当前活跃星间链路数量。 |
| `active_sgl_links` | 当前活跃星地链路数量。 |
| `link_occupancy_percent` | 节点链路占用比例。 |
| `communication_power_w` | 通信功耗，单位 W。 |
| `queued_traffic_mb` | 节点排队业务量，单位 MB。 |
| `dropped_traffic_mb` | 节点丢弃业务量，单位 MB。 |
| `cache_used_mb` | 节点缓存占用，单位 MB。 |
| `telemetry_generated_mb` | 当前时间片生成的遥测量，单位 MB。 |
| `telemetry_buffer_mb` | 待下传遥测缓存，单位 MB。 |
| `telemetry_downlinked_mb` | 当前时间片已下传遥测量，单位 MB。 |
| `telemetry_dropped_mb` | 当前时间片丢弃遥测量，单位 MB。 |

### 2.2 `links.csv`

每个时间片下每条链路的真值状态。

| 字段 | 含义 |
|---|---|
| `slice_index` | 时间片编号。 |
| `time` | 当前仿真时间。 |
| `minute` | 当前仿真分钟。 |
| `link_id` | 链路唯一编号。 |
| `source` | 链路源端节点。 |
| `target` | 链路目标端节点。 |
| `kind` | 链路类型，例如轨内、轨间或星地链路。 |
| `inter_plane_direction` | 轨间链路方向标记。 |
| `design_candidate` | 是否为拓扑设计候选链路。 |
| `source_antenna_id` | 源端占用的天线编号。 |
| `target_antenna_id` | 目标端占用的天线编号。 |
| `status` | 链路状态，例如 `up`、`warning`、`down`。 |
| `is_active` | 当前是否实际可用。 |
| `restriction_reason` | 链路受限或断开的原因，例如极区限制、距离过远、地球遮挡等。 |
| `line_of_sight` | 两端是否满足视距条件。 |
| `distance_km` | 链路距离，单位 km。 |
| `latency_ms` | 链路传播/排队时延，单位 ms。 |
| `bandwidth_mbps` | 名义带宽，单位 Mbps。 |
| `utilization_percent` | 链路利用率。 |
| `demand_traffic_mbps` | 当前业务需求流量。 |
| `carried_traffic_mbps` | 当前实际承载流量。 |
| `queued_traffic_mb` | 链路排队业务量，单位 MB。 |
| `dropped_traffic_mb` | 链路丢弃业务量，单位 MB。 |
| `congestion_percent` | 链路拥塞程度。 |
| `snr_db` | 信噪比，单位 dB。 |
| `sinr_db` | 信干噪比，单位 dB。 |
| `capacity_mbps` | 香农/链路预算估计容量，单位 Mbps。 |
| `effective_capacity_mbps` | 考虑可用比例、干扰、调制等后的有效容量。 |
| `fspl_db` | 自由空间路径损耗，单位 dB。 |
| `received_power_dbm` | 接收功率，单位 dBm。 |
| `noise_power_dbm` | 噪声功率，单位 dBm。 |
| `interference_power_dbm` | 干扰功率，单位 dBm。 |
| `interference_count` | 聚合干扰源数量。 |
| `channel_id` | 信道编号，用于频率复用/邻频干扰建模。 |
| `mcs_id` | 调制编码等级编号。 |
| `packet_error_rate` | 估计误包率。 |
| `doppler_shift_hz` | 多普勒频移，单位 Hz。 |
| `availability_factor` | 链路可用比例。 |
| `solar_interference_blocked` | 是否因太阳规避/太阳干扰被阻断。 |

### 2.3 `routes.csv`

每个时间片下业务任务的路由结果。

| 字段 | 含义 |
|---|---|
| `slice_index` | 时间片编号。 |
| `time` | 当前仿真时间。 |
| `minute` | 当前仿真分钟。 |
| `task_id` | 业务任务编号。 |
| `source` | 任务源节点。 |
| `target` | 任务目标节点。 |
| `algorithm` | 路由算法，例如 `shortest-path`。 |
| `status` | 路由状态，例如成功、部分承载或不可达。 |
| `task_type` | 任务类型。 |
| `hop_count` | 路由跳数。 |
| `distance_km` | 端到端路径距离。 |
| `latency_ms` | 端到端时延。 |
| `traffic_mbps` | 任务需求流量。 |
| `priority` | 任务优先级。 |
| `carried_traffic_mbps` | 实际承载流量。 |
| `queued_traffic_mb` | 该任务造成的排队量。 |
| `dropped_traffic_mb` | 该任务丢弃量。 |
| `task_telemetry_node_id` | 与任务遥测生成关联的节点。 |
| `task_telemetry_generated_mb` | 任务产生的遥测量。 |
| `path` | 路由经过的节点序列。 |
| `link_ids` | 路由经过的链路序列。 |
| `reason` | 路由异常或不可达原因。 |

### 2.4 `metrics.csv`

每个时间片的全网汇总指标。

| 字段 | 含义 |
|---|---|
| `slice_index` | 时间片编号。 |
| `time` | 当前仿真时间。 |
| `minute` | 当前仿真分钟。 |
| `orbit_model` | 轨道传播模式。 |
| `routing_algorithm` | 当前路由算法。 |
| `nodes` | 节点数量。 |
| `links` | 链路数量。 |
| `active_links` | 当前活跃链路数量。 |
| `link_availability_percent` | 链路可用率。 |
| `warning_nodes` | 告警节点数量。 |
| `degraded_nodes` | 退化节点数量。 |
| `active_tasks` | 当前活跃任务数量。 |
| `routed_tasks` | 成功进入路由流程的任务数量。 |
| `unroutable_tasks` | 当前不可路由任务数量。 |
| `avg_cpu_percent` | 全网平均 CPU 利用率。 |
| `avg_energy_wh` | 全网平均电池能量，单位 Wh。 |
| `total_queue_mb` | 全网总排队业务量。 |
| `total_drop_mb` | 全网总丢弃业务量。 |
| `total_forwarding_mbps` | 全网总转发负载。 |
| `total_downlink_mbps` | 全网总下行负载。 |
| `total_telemetry_buffer_mb` | 全网待下传遥测缓存。 |
| `total_telemetry_downlinked_mb` | 全网已下传遥测量。 |
| `max_link_congestion_percent` | 当前最大链路拥塞程度。 |
| `max_communication_power_w` | 当前最大节点通信功耗。 |
| `available_ground_windows` | 当前可用星地回传窗口数量。 |

## 3. 第二阶段 INT 遥测过程数据集

典型目录：

```text
stage2-int/runs/<run>/stage2-int/
```

这些文件来自 INT 探测、逐跳采集、报告生成和回传过程，是非全知遥测视角。

### 3.1 `probe-int-hop-records-path-balance.csv`

probe-int 每一跳写入的 INT metadata。

| 字段 | 含义 |
|---|---|
| `packet_id` | INT 探测包编号。 |
| `probe_id` | probe 规划编号。 |
| `probe_type` | probe 类型。 |
| `planning_algorithm` | probe 路径规划算法。 |
| `task_id` | probe 对应任务编号。 |
| `slice_index` | 时间片编号。 |
| `time` | 当前仿真时间。 |
| `hop_index` | 当前是路径上的第几跳。 |
| `node_id` | 当前经过的节点。 |
| `role` | 当前节点在 probe 中的角色，例如源、中继、sink。 |
| `previous_hop` | 上一跳节点。 |
| `next_hop` | 下一跳节点。 |
| `ingress_link_id` | 入链路编号。 |
| `egress_link_id` | 出链路编号。 |
| `observation_scope` | 本跳观测范围。 |
| `local_port_peer` | 本地端口对端节点。 |
| `observed_node_mode` | 观测到的节点模式。 |
| `observed_cpu_percent` | 观测到的 CPU 利用率。 |
| `observed_queue_depth` | 观测到的节点队列深度。 |
| `observed_queued_traffic_mb` | 观测到的节点排队量。 |
| `observed_cache_used_mb` | 观测到的节点缓存占用。 |
| `observed_energy_percent` | 观测到的节点电量百分比。 |
| `observed_can_accept_tasks` | 观测到的节点是否可接收任务。 |
| `observed_link_id` | 观测到的链路编号。 |
| `observed_link_status` | 观测到的链路状态。 |
| `observed_link_active` | 观测到的链路是否活跃。 |
| `observed_link_utilization_percent` | 观测到的链路利用率。 |
| `observed_link_latency_ms` | 观测到的链路时延。 |
| `observed_link_capacity_mbps` | 观测到的链路容量。 |
| `observed_link_congestion_percent` | 观测到的链路拥塞程度。 |
| `observed_link_queued_mb` | 观测到的链路排队量。 |
| `observed_link_dropped_mb` | 观测到的链路丢弃量。 |
| `carried_traffic_mbps` | 当前 probe 关联业务实际承载流量。 |
| `demand_traffic_mbps` | 当前 probe 关联业务需求流量。 |

### 3.2 `probe-int-reports-path-balance.csv`

probe 到达 sink 后形成的 INT 报告。

| 字段 | 含义 |
|---|---|
| `report_id` | INT 报告编号。 |
| `packet_id` | 对应探测包编号。 |
| `task_id` | 对应任务编号。 |
| `probe_id` | 对应 probe 编号。 |
| `probe_type` | probe 类型。 |
| `planning_algorithm` | probe 规划算法。 |
| `slice_index` | 时间片编号。 |
| `time` | 当前仿真时间。 |
| `sink_node` | 生成报告的 sink 节点。 |
| `ground_station` | 目标地面站。 |
| `direct_linked_satellite` | 可直接下传到地面站的卫星。 |
| `reporting_status` | 回传规划状态。 |
| `reporting_hops` | 回传路径跳数。 |
| `reporting_latency_ms` | 回传路径时延。 |
| `reporting_path` | 报告回传路径。 |
| `reporting_link_ids` | 回传路径使用的链路编号。 |
| `record_count` | 报告中包含的 hop record 数量。 |
| `report_size_bytes` | 报告大小，单位 bytes。 |
| `status` | 报告状态，例如 `downlinked` 或 `dropped`。 |
| `drop_reason` | 报告未下传原因，例如 `no-reporting-path`。 |

## 4. Ground OAM 重构数据集

典型目录：

```text
stage2-int/runs/<run>/stage2-int/ground-probe-path-balance/
```

Ground OAM 只能使用已经下传的 INT 报告进行重构，不能直接读取第一阶段真值。

### 4.1 `ground-reconstructed-nodes.csv`

Ground OAM 重构出的节点状态。

| 字段 | 含义 |
|---|---|
| `slice_index` | 时间片编号。 |
| `node_id` | 节点编号。 |
| `observed` | 该节点在该时间片是否被 INT 观测到。 |
| `last_observed_slice` | 最近一次被观测到的时间片。 |
| `mode_estimate` | 重构出的节点模式。 |
| `cpu_percent_estimate` | 重构出的 CPU 利用率。 |
| `queue_depth_estimate` | 重构出的队列深度。 |
| `queued_traffic_mb_estimate` | 重构出的排队业务量。 |
| `cache_used_mb_estimate` | 重构出的缓存占用。 |
| `energy_percent_estimate` | 重构出的电量百分比。 |
| `confidence` | 重构置信度。 |

### 4.2 `ground-reconstructed-links.csv`

Ground OAM 重构出的链路状态。

| 字段 | 含义 |
|---|---|
| `slice_index` | 时间片编号。 |
| `link_id` | 链路编号。 |
| `observed` | 该链路在该时间片是否被 INT 观测到。 |
| `last_observed_slice` | 最近一次被观测到的时间片。 |
| `status_estimate` | 重构出的链路状态。 |
| `active_estimate` | 重构出的链路活跃状态。 |
| `utilization_percent_estimate` | 重构出的链路利用率。 |
| `latency_ms_estimate` | 重构出的链路时延。 |
| `capacity_mbps_estimate` | 重构出的链路容量。 |
| `congestion_percent_estimate` | 重构出的链路拥塞程度。 |
| `confidence` | 重构置信度。 |

### 4.3 `ground-delivered-reports.csv`

成功下传到 Ground OAM 的 INT 报告。

| 字段 | 含义 |
|---|---|
| `report_id` | 报告编号。 |
| `packet_id` | 对应探测包编号。 |
| `task_id` | 对应任务编号。 |
| `probe_id` | 对应 probe 编号。 |
| `probe_type` | probe 类型。 |
| `planning_algorithm` | probe 规划算法。 |
| `slice_index` | 报告生成时间片。 |
| `time` | 报告生成时间。 |
| `sink_node` | 生成报告的卫星节点。 |
| `ground_station` | 接收报告的地面站。 |
| `direct_linked_satellite` | 直接连接地面站的卫星。 |
| `reporting_status` | 回传规划状态。 |
| `reporting_hops` | 回传路径跳数。 |
| `reporting_latency_ms` | 回传路径时延。 |
| `reporting_path` | 报告回传路径。 |
| `reporting_link_ids` | 报告回传链路编号。 |
| `record_count` | 报告包含的 hop record 数量。 |
| `report_size_bytes` | 报告大小。 |
| `status` | 原始报告状态。 |
| `drop_reason` | 若未送达则记录原因；成功送达通常为空。 |
| `ground_status` | Ground OAM 侧接收状态。 |
| `downlinked_slice` | 实际下传到地面的时间片。 |
| `delivery_delay_slices` | 从生成到下传经历的时间片延迟。 |

### 4.4 `ground-undelivered-reports.csv`

未能下传到 Ground OAM 的 INT 报告。字段与 `ground-delivered-reports.csv` 基本一致，但 `ground_status` 和 `drop_reason` 用于解释未送达原因。

常见未送达原因：

- `no-reporting-path`：当前没有可用回传路径。
- 星地窗口不可用。
- 报告生成节点无法连接到可下传卫星。

## 5. 关键区别

| 数据集 | 视角 | 主要用途 |
|---|---|---|
| 业务输入 CSV | 外部输入 | 驱动卫星网络业务、计算、存储、队列和能耗响应。 |
| `nodes.csv` / `links.csv` | 第一阶段全知真值 | 作为模型真值、ML 标签和 INT 准确率检验基准。 |
| `routes.csv` | 第一阶段全知真值 | 记录每个业务任务在每个时间片的路由路径和承载情况。 |
| `metrics.csv` | 第一阶段汇总真值 | 观察全网可用率、平均 CPU、电量、拥塞和遥测缓存。 |
| `probe-int-hop-records-*.csv` | INT 逐跳观测 | 记录 INT 在每跳实际采集到的节点和链路 metadata。 |
| `probe-int-reports-*.csv` | INT 报告视角 | 记录 probe 汇总报告、回传路径、报告大小和下传状态。 |
| `ground-reconstructed-*.csv` | Ground OAM 非全知重构 | 记录地面 OAM 根据已下传报告重构出的节点/链路状态。 |

一句话概括：

```text
第一阶段真值告诉你网络实际发生了什么；
第二阶段 INT 数据告诉你遥测系统实际看到了什么；
Ground OAM 重构结果告诉你地面侧最终恢复出了多少全网状态。
```
