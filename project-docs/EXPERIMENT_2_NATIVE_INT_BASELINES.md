# 实验 2：原生 INT 基线对照实验

## 1. 实验目的

实验 2 用来建立第二阶段 INT 遥测算法的对比基线。它不再验证第一阶段模型真实性，而是在固定第一阶段卫星网络真值的前提下，只改变 INT 遥测策略，观察不同原生 INT 方法在动态 LEO 卫星网络中的覆盖率、开销和稳定性。

后续接入 LEO-INT-MC、拓扑预测、矩阵补全、OAM 自适应采样等改进方法时，都应该和本实验中的基线进行对比。

## 2. 固定条件

默认输入使用实验 1 已校准过的第一阶段真值：

```text
reports/experiment1-satellite-data-authenticity/stage1-truth
```

该目录包含：

- `nodes.csv`：每个时间片的卫星节点状态真值；
- `links.csv`：每个时间片的链路状态真值；
- `routes.csv`：业务任务路由结果；
- `metadata.json`：星座规模、TLE 快照、业务数据集和真值指纹。

实验 2 的 INT 运行过程不直接读取真值来补全状态。真值只在 Ground OAM 评估阶段用于计算覆盖率和误差。

为了突出“原生 INT 基线”的真实观测能力，实验 2 的 Ground OAM 后处理采用纯 observed/unknown 评估：只使用已下传 INT report 对应的 hop records，不启用 stale carry-over、OAM 先验估计或矩阵补全。这样可以避免后处理补全能力稀释不同 INT 策略之间的覆盖差异。

## 3. 四类基线

### 3.1 traffic-int

`traffic-int` 只在业务流经过的路径上携带 INT metadata。

特点：

- 不额外发送主动探测包；
- 遥测开销最低；
- 覆盖率依赖业务流分布；
- 没有业务经过的节点和链路会保持 unknown。

它用于证明：业务随路遥测开销低，但不能保证全网感知。

### 3.2 full probe-int

`full probe-int` 主动规划覆盖全网活动链路的探测路径，并在经过节点执行本地邻接链路扫描。

特点：

- 覆盖率最高；
- 可以作为原生 INT 的高覆盖上界；
- INT metadata、report bytes、probe forwarding bytes 和节点处理能耗最高。

它用于证明：全量主动探测可以获得高覆盖，但遥测开销不可忽略。

### 3.3 shortest-path probe

`shortest-path probe` 在相同候选路径集合中优先选择跳数更短的 probe path，并按目标活动链路采样率停止选择。

特点：

- 比 full probe-int 开销低；
- 比随机采样更稳定；
- 容易集中在短路径或局部区域，存在路径偏置。

它用于证明：单纯选择短路径不能可靠代表全网状态。

### 3.4 random sampling

`random sampling` 在与 `shortest-path probe` 相同的逐时间片路径链路数预算下随机选择 probe path，并使用多个 seed 重复运行。路径链路数近似对应 INT hop metadata 的主要字节开销，因此比单纯固定 probe 数量更公平。

特点：

- 实现简单；
- 不利用卫星轨道面、槽位、极区断链、业务热点等结构信息；
- seed 间覆盖率和误差可能波动明显。

它用于证明：盲随机采样不是动态 LEO 全网遥测的稳定方案。

## 4. 核心指标

节点覆盖率：

```text
NodeCoverage = observed_nodes / truth_nodes
```

活动链路覆盖率：

```text
ActiveLinkCoverage = observed_active_links / truth_active_links
```

遥测字节开销：

```text
TelemetryOverhead = metadata_bytes + report_bytes + probe_base_bytes
```

随机采样稳定性：

```text
RandomStability = Std(coverage over random seeds)
```

其中 `observed_*` 表示 Ground OAM 通过已下传 INT report 重构出的可观测对象，`truth_*` 只在实验结束后的评估阶段读取。

## 5. 运行命令

默认运行：

```powershell
npm run experiment:native-int-baselines
```

指定输入和输出目录：

```powershell
npm run experiment:native-int-baselines -- --input reports/experiment1-satellite-data-authenticity/stage1-truth --out reports/experiment2-native-int-baselines
```

调整 shortest 的目标活动链路采样率。随机采样会继承 shortest 在每个时间片消耗的路径链路数预算，再在相近 hop/字节预算下随机选择 probe path：

```powershell
npm run experiment:native-int-baselines -- --target-active-link-coverage 0.25
```

调整随机采样 seed：

```powershell
npm run experiment:native-int-baselines -- --random-seeds 11,23,37,51,73
```

## 6. 输出产物

默认输出目录：

```text
reports/experiment2-native-int-baselines/
```

主要文件：

| 文件 | 说明 |
|---|---|
| `experiment2-native-int-baselines-report.html` | 图文并茂的实验 2 可视化报告 |
| `experiment2-native-int-baselines-report.md` | Markdown 论文/文档版报告 |
| `experiment2-native-int-baselines-report.json` | 机器可读完整报告 |
| `experiment2-baseline-summary.csv` | 四类基线总体指标 |
| `experiment2-coverage-by-slice.csv` | 逐时间片覆盖率和遥测开销 |
| `experiment2-random-seed-summary.csv` | 随机采样各 seed 结果 |
| `stage2/` | 各基线的 INT hop records、reports、probe paths 和 overhead 明细 |
| `ground-oam/` | 各基线的 Ground OAM 重构结果和真值评估 |

## 7. 结果解读

理想情况下，实验 2 应展示以下规律：

- `traffic-int` 的遥测字节最少，但节点和链路覆盖不足；
- `full probe-int` 的覆盖率最高，但开销最大；
- `shortest-path probe` 的开销低于 full probe-int，但覆盖存在路径偏置；
- `random sampling` 的平均覆盖可能接近某个预算目标，但 seed 间方差会暴露不稳定性。

这组结论构成后续改进方法的必要性论证：真正有价值的改进不应只追求最高覆盖，而应在接近 full probe-int 重构质量的同时，显著降低遥测字节、探测跳数和节点处理能耗。
