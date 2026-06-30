# Stage 1 Black-Box Ports

第二阶段通过端口读取第一阶段黑盒输出。本文件规定每个端口的权限边界。

## 1. Route Port

来源：

- `routes.csv`
- 或 `truth.json.slices[].routes`

允许运行时使用的字段：

- `slice_index`
- `time`
- `task_id`
- `source`
- `target`
- `status`
- `task_type`
- `priority`
- `traffic_mbps`
- `carried_traffic_mbps`
- `path`
- `link_ids`

用途：

- traffic-int 随业务路径生成 INT packets。
- 判断 packet 的 source/transit/sink 节点。

限制：

- 只能用于当前 routed 路径。
- 不能由 route port 推断未经过节点或链路状态。

## 2. Topology Snapshot Port

来源：

- `nodes.csv`
- `links.csv`
- 或 `truth.json.slices[]`

允许运行时使用的字段：

- 节点 ID 列表。
- 当前时间片 active ISL 列表。
- 链路 `source` / `target` / `kind` / `is_active`。

用途：

- probe-int 路径规划。
- 构建论文中的拓扑图 `G(V,E)`。

限制：

- 该端口模拟运营方基于可预测轨道与链路规则做离线/在线路径规划。
- 不能用于直接生成观测状态。

## 3. Local State Port

来源：

- `nodes.csv`
- `links.csv`

允许运行时读取：

- 当前 hop 的 `node_id` 对应节点状态。
- 当前 hop 的 ingress/egress `link_id` 对应链路状态。

用途：

- INT source/transit/sink 逐跳写入 telemetry metadata。

限制：

- 不能扫描同一时间片所有节点。
- 不能读取未经过节点。
- 不能读取未经过链路。
- 不能用真值填充 unknown。

## 4. Ground Window Port

来源：

- `truth.json.slices[].groundLinks`
- 后续也可从独立 `ground-links.csv` 导出。

用途：

- 选择 direct-linked satellite。
- 建立 reporting path。
- 计算 INT report 下传容量、排队、延迟和丢弃。

## 5. Truth Evaluation Port

来源：

- `truth.json`
- `nodes.csv`
- `links.csv`
- `routes.csv`
- `metrics.csv`

用途：

- 实验结束后计算覆盖率、误差、时延和开销。

限制：

- 仅允许 `evaluation/` 模块使用。
- INT 运行过程不能调用该端口补齐状态。

