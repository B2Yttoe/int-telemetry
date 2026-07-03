# 实验 1：基于外部公开数据的卫星网络仿真真实性验证

本实验用于回答一个更严格的问题：项目生成的卫星节点、链路、业务和性能数据，是否能被外部公开数据支撑为“高仿真数据”。

此前的内部一致性评分只能说明模型满足自身约束，不能单独证明仿真数据接近真实世界。因此实验 1 已改为外部对照实验：把模型输出与 CelesTrak、Cloudflare Radar、RIPE Atlas 等公开数据源进行对比。结果不强行美化，能对齐的给出误差，不能对齐的明确标注证据缺失或偏差。

## 运行命令

默认运行 72x22 Starlink 主壳层外部对照实验：

```bash
npm run experiment:realism
```

默认配置：

- 模型 TLE 快照：`data/tle-snapshots/celestrak-starlink-real-walker-72x22.json`
- 业务数据集：`reports/experiment1-satellite-data-authenticity/input/radar-fitted-traffic.csv`
- 时间片：48
- 输出目录：`reports/experiment1-satellite-data-authenticity/`
- 外部轨道数据：实时请求 CelesTrak Starlink GP/TLE，失败时使用本地缓存公开快照
- 外部网络性能数据：实时请求 RIPE Atlas AS14593 Starlink 探针公开 ping 测量
- 外部业务流量数据：优先读取 `--radar-csv` 或 `CLOUDFLARE_API_TOKEN`

可复用已有第一阶段输出，避免重复导出：

```bash
npm run experiment:realism -- --reuse-truth --truth-dir reports/experiment1-satellite-data-authenticity/stage1-truth
```

本项目当前正式实验使用冻结的 Cloudflare Radar JSON 原始响应驱动业务曲线，可复现命令为：

```powershell
npm run generate:radar-traffic -- --snapshot data\tle-snapshots\celestrak-starlink-real-walker-72x22.json --profile traffic-calibration\cloudflare-radar-profile.json --radar-json reports\_archive\experiment1-pre-final-20260703-211932\experiment1-external-realism-72x22\external\cloudflare-radar\radar-as14593-traffic.json --radar-window latest --out reports\experiment1-satellite-data-authenticity\input\radar-fitted-traffic.csv --metadata-out reports\experiment1-satellite-data-authenticity\input\radar-fitted-traffic.metadata.json --slices 48

npm run experiment:realism -- --out reports\experiment1-satellite-data-authenticity --snapshot data\tle-snapshots\celestrak-starlink-real-walker-72x22.json --tasks reports\experiment1-satellite-data-authenticity\input\radar-fitted-traffic.csv --slices 48 --radar-json reports\_archive\experiment1-pre-final-20260703-211932\experiment1-external-realism-72x22\external\cloudflare-radar\radar-as14593-traffic.json --radar-window latest --ripe-max-probes 16 --ripe-hours 4
```

使用用户从 Cloudflare Radar 页面或 API 导出的 CSV：

```bash
npm run experiment:realism -- --radar-csv path/to/as14593-radar-traffic.csv
```

使用 Cloudflare Radar API：

```bash
$env:CLOUDFLARE_API_TOKEN="你的 Radar Read token"
npm run experiment:realism
```

## 输出文件

| 文件 | 作用 |
|---|---|
| `external-realism-report.html` | 图文可视化报告，包含实验原理、外部数据源状态、四类对照实验和结论。 |
| `external-realism-report.md` | 论文写作可引用的文字版总结。 |
| `external-realism-report.json` | 机器可读完整实验结果。 |
| `orbit-external-comparison.csv` | 同一 NORAD 卫星的模型轨道输出与外部 CelesTrak GP 记录对照。 |
| `constellation-shell-comparison.csv` | 模型 72x22 选取与外部目标壳层 RAAN 分布对照。 |
| `traffic-external-comparison.csv` | 模型业务曲线与 Cloudflare Radar 数值序列或本地校准模板的归一化对照。 |
| `network-performance-external-comparison.csv` | 模型用户侧 RTT、内部任务路由时延与 RIPE Atlas Starlink ping RTT 的汇总对照。 |
| `user-facing-rtt-comparison.csv` | 逐 RIPE 探针样本的用户侧 RTT 估计，包括时间片、探针位置、接入卫星、区域网关、星间回退路径和模型 RTT。 |
| `external-source-status.csv` | 每个外部数据源是否成功获取、是否缺少 token、是否使用缓存。 |
| `stage1-truth/` | 本次实验使用的第一阶段模型输出。 |

## 子实验 1：轨道真实性验证

外部数据源：

- CelesTrak Starlink GP/TLE：`https://celestrak.org/NORAD/elements/gp.php?NAME=STARLINK&FORMAT=JSON`

对照方法：

1. 用 NORAD ID 匹配模型选取的卫星和外部 CelesTrak 记录。
2. 从平均运动推导外部轨道高度。
3. 比较模型输出平均高度、TLE 倾角、平均运动、RAAN 与外部记录的误差。

核心公式：

```text
n_rad/s = mean_motion_rev_day * 2π / 86400
a = (μ / n_rad/s^2)^(1/3)
h = a - R_E
```

```text
MAE_h = (1 / N) * Σ |h_sim,i - h_ext,i|
```

这一项能较强验证轨道层真实性，因为轨道状态确实有公开外部目录可对照。

## 子实验 2：星座规模和轨道壳层验证

外部数据源：

- CelesTrak Starlink 全量 GP/TLE 目录

对照方法：

1. 从外部 Starlink 目录中筛选接近 `53 deg / 550 km` 的目标壳层。
2. 对比外部目标壳层卫星数量和模型选取卫星数量。
3. 对比模型选取卫星和外部目标壳层的 RAAN 分布。

RAAN 分布相似度：

```text
J_hist = 1 - 0.5 * Σ_b |p_sim,b - p_ext,b|
```

其中 `p_sim,b` 和 `p_ext,b` 是第 `b` 个 RAAN 分箱中的归一化卫星比例。

这一项很重要，因为 72x22 是真实壳层的抽样近似，而不是完整 Starlink 全量复刻。如果外部目标壳层明显多于 1584 颗，报告会如实展示规模覆盖不足。

## 子实验 3：业务流量真实性验证

外部数据源优先级：

1. 用户提供的 Cloudflare Radar AS14593 CSV：`--radar-csv`
2. Cloudflare Radar API：需要 `CLOUDFLARE_API_TOKEN`
3. 如果没有 Radar 数值序列，则只展示模型业务曲线和本地校准模板，不把它计为强外部真实性证据

Cloudflare 相关入口：

- AS14593 概览：`https://radar.cloudflare.com/as14593`
- AS14593 流量：`https://radar.cloudflare.com/traffic/as14593`
- Radar API 文档：`https://developers.cloudflare.com/radar/get-started/first-request/`

对照方法：

1. 将模型每个时间片的业务总量求和。
2. 将 Radar 流量序列按同一窗口对齐到相同时间片数量；正式实验默认使用 `latest` 窗口，而不是把 7 天序列整体压缩到 48 个时间片。
3. 两者归一化后计算相关系数和 MAE。

```text
ρ = cov(X_sim, X_ext) / (σ_sim * σ_ext)
```

```text
MAE = (1 / T) * Σ_t |x_sim,t - x_ext,t|
```

如果没有 Cloudflare token 或外部 CSV，本项结论必须写成“外部数值证据缺失”，不能把本地合成 profile 说成真实流量。

## 子实验 4：网络性能真实性验证

外部数据源：

- RIPE Atlas AS14593 Starlink 探针：`https://atlas.ripe.net/api/v2/probes/?asn_v4=14593&status=1`
- RIPE Atlas built-in measurements 文档：`https://atlas.ripe.net/docs/built-in-measurements/`

默认对照：

- RIPE Atlas measurement `1001`
- 类型：公开 ping
- 默认抽样：最近 4 小时，最多 16 个公开 Starlink 探针

对照方法：

1. 统计 RIPE Atlas ping RTT 的 P50、P95、均值和丢包率。
2. 根据 RIPE 探针经纬度、当前时间片卫星位置和区域网关/PoP 抽象，估计模型中的用户侧 RTT。
3. 如果同一颗卫星同时可见用户和区域网关，则采用“用户-卫星-网关”两段星地链路；否则用当前时间片可用 ISL 图计算接入卫星到网关卫星的最短星间回退时延。
4. 同时保留模型 routed 任务的 `route_latency_ms` 和 `estimated_end_to_end_latency_ms`，但它们只作为星座内部压力指标，不再直接作为 RIPE ping 的判定口径。

用户侧 RTT 估计公式：

```text
RTT_user_sim = 2 * (d_user,sat / c + d_sat,gateway / c + tau_proc + tau_terr)
```

当需要星间回退时：

```text
RTT_user_sim = 2 * (d_user,sat / c + L_ISL_shortest + d_gateway_sat,gateway / c + tau_proc + tau_terr)
```

其中：

- `d_user,sat` 是用户探针到可见接入卫星的距离。
- `d_sat,gateway` 是同一卫星到区域网关/PoP 的距离。
- `L_ISL_shortest` 是当前时间片活动 ISL 图上的最短一程星间链路时延。
- `tau_proc` 是简化处理时延，默认 3 ms/单程。
- `tau_terr` 是地面出口和公共目标的简化尾部时延，默认 4 ms/单程。
- 默认星地可见仰角门限为 10°，用于公开 RTT 量级验证；这比论文中常见的保守业务接入门限更宽松，目的是避免用过粗区域网关抽象人为放大长尾。

```text
ratio_p50_user = P50_RTT_user_sim / P50_RTT_RIPE
```

这样可以避免把两种不同测量点混在一起：RIPE Atlas 是 Starlink 用户接入网到公共目标的端到端 ping，内部 `route_latency_ms` 是模型业务在星座中的路径时延。前者用于外部真实性量级验证，后者用于解释星座内部业务压力、拥塞和长路径负载。

## 论文表述建议

推荐写法：

> 本文首先进行基于外部公开数据的仿真真实性验证。实验将第一阶段模型输出与 CelesTrak Starlink GP/TLE、Cloudflare Radar AS14593 公开流量入口和 RIPE Atlas Starlink 探针测量进行对照。轨道层通过同一 NORAD 卫星的高度、倾角和平均运动误差验证；星座层通过目标壳层规模和 RAAN 分布验证；业务层通过 Cloudflare Radar 数值序列验证；网络性能层通过 RIPE 探针位置、模型卫星几何和区域网关/PoP 抽象生成用户侧 RTT，并与 RIPE Atlas RTT 做量级对照。对无法由公开数据直接观测的逐星资源、队列和星间链路内部状态，本文仅将其作为经外部可观测数据约束后的仿真真值，而不声称其等价于运营商内部遥测。

需要避免的写法：

- “模型已经完全复刻真实 Starlink 内部网络。”
- “内部一致性评分可以证明数据是真实的。”
- “Cloudflare Radar profile 等价于 Starlink 内部业务 trace。”
- “RIPE Atlas ping 可以直接验证每条星间链路时延。”
- “模型内部任务路由时延可以直接拿来和 RIPE Atlas 用户 ping RTT 对比。”

更严谨的写法：

- “轨道层有强外部公开数据支撑。”
- “星座规模是目标壳层的抽样近似，需要报告覆盖比例。”
- “业务流量真实性取决于是否提供 Radar API/CSV 数值序列。”
- “网络性能对照使用用户侧 RTT 口径验证量级；内部任务路由时延只作为星座压力指标，不等价于 RIPE ping，也不等价于内部链路真值。”
