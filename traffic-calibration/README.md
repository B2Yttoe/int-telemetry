# Cloudflare Radar 校准业务数据

本目录用于提升业务输入数据集的真实性。它不直接提供真实 Starlink 业务日志，而是把公开互联网流量统计特征转化为当前卫星网络模型可以使用的任务数据集。

## 当前定位

当前 profile 是：

```text
traffic-calibration/cloudflare-radar-profile.json
```

它是一个可复现的统计校准模板，参考 Cloudflare Radar 公开说明中的几类维度：

- 全球/区域互联网流量趋势；
- NetFlows 网络流量趋势；
- HTTP、API、bot/human 等业务类型比例；
- 区域差异和异常窗口。

注意：该 profile 不是 Cloudflare Radar API 的原始导出，也不是卫星运营商业务日志。它的用途是把原本手工构造的业务输入升级为“参考公开互联网统计特征的合成业务”。

## 数据流

```text
Cloudflare Radar 统计特征 / 本地 profile
        ↓
时间权重、地区权重、业务类型比例、异常窗口
        ↓
scripts/generateRadarCalibratedTraffic.mjs
        ↓
任务 CSV + metadata JSON
        ↓
real-tle-sgp4 卫星模型 / INT 遥测实验
```

## 生成 Starlink 主壳层 47x14 数据集

```bash
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-47x14.json --profile traffic-calibration/cloudflare-radar-profile.json --out examples/datasets/radar-calibrated-starlink-main-47x14-48-traffic.csv --slices 48
```

对应元数据：

```text
examples/datasets/radar-calibrated-starlink-main-47x14-48-traffic.metadata.json
```

当前生成结果：

```text
tasks: 755
routed_tasks: 683
local_tasks: 72
total_traffic_mbps: 112655.77
total_compute_units: 9815.98
time_weight_range: 0.50 - 1.48
anomaly_count: 3
```

校验：

```bash
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-main-47x14-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-47x14.json
```

当前校验结果：

```text
Warnings: 0
Errors: 0
Dataset fingerprint: 4e76d3b4
```

## 生成主壳层 8x8 快速实验数据集

```bash
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json --profile traffic-calibration/cloudflare-radar-profile.json --out examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv --slices 48
```

校验：

```bash
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json
```

当前校验结果：

```text
Warnings: 0
Errors: 0
Dataset fingerprint: 2ccc391f
```

8x8 INT 烟测：

```bash
npm run int:experiment -- --tasks examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json --mode operational --algorithm path-balance --out stage2-int/runs/radar-calibrated-main-8x8-int-smoke --skip-verify
```

## 生成 72x22 规模压力对照数据集

`data/tle-snapshots/celestrak-starlink-real-walker-72x22.json` 仍可用于规模压力对照。需要注意，该快照来自当前 CelesTrak 公开目录中可抽样的较大壳层，平均约 `43°/490 km`，不是默认主壳层 `53°/550 km`。

```bash
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --profile traffic-calibration/cloudflare-radar-profile.json --out examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --slices 48
```

## 如何替换为真实 Radar 导出

Cloudflare Radar API 需要 API token。后续如果需要进一步提高真实性，可以从 Radar API 或 Data Explorer 下载某一地区、某一时间范围的 HTTP / NetFlows / bot-human / API traffic 时间序列，然后把 `cloudflare-radar-profile.json` 中的字段替换为真实查询结果归一化后的值。

建议保留以下字段：

```text
profile_id
data_mode
source_references
time_series[].traffic_weight
time_series[].human_share
time_series[].api_share
time_series[].bot_share
regions[].demand_weight
traffic_classes[]
anomalies[]
```

替换真实导出后，metadata 会继续记录 profile 路径、快照 fingerprint 和输出统计，便于论文复现。

## 论文表述建议

严谨表述：

> 业务输入不是运营商真实业务日志，而是参考 Cloudflare Radar 公开互联网流量统计特征构造的合成业务数据集。轨道层使用 CelesTrak 真实 GP/OMM 快照和 SGP4 传播，业务层使用 Radar 风格的时间、区域、业务类型和异常扰动权重进行校准，节点与链路状态由卫星网络模型计算得到。

不建议表述：

> 本文使用了真实 Starlink 业务流量。

## 参考来源

- Cloudflare Radar overview: https://developers.cloudflare.com/radar/
- Cloudflare Radar NetFlows: https://developers.cloudflare.com/radar/investigate/netflows/
- Cloudflare Radar traffic dashboard: https://radar.cloudflare.com/traffic

## Radar 原始时序驱动模式

旧的 `radar-calibrated` 数据集使用的是本地 `cloudflare-radar-profile.json` 模板：它参考了 Cloudflare Radar 的公开统计维度，但业务曲线主要由本地 `time_series[].traffic_weight` 控制。因此它只能称为“Radar 风格校准”，不能称为“拟合 Radar 原始曲线”。

新的 `radar-fitted` 模式允许直接接入 Cloudflare Radar API 保存下来的 JSON 响应：

```bash
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --profile traffic-calibration/cloudflare-radar-profile.json --radar-json reports/experiment1-external-realism-72x22/external/cloudflare-radar/radar-as14593-traffic.json --radar-window latest --out examples/datasets/radar-fitted-starlink-72x22-48-traffic.csv --metadata-out examples/datasets/radar-fitted-starlink-72x22-48-traffic.metadata.json --slices 48
```

该模式会从 Radar JSON 中提取数值时间序列，默认取最新 48 个外部观测点，与 48 个模型时间片一一对应，然后用 min-max 归一化把 Radar 曲线映射到业务强度权重：

```text
traffic_weight(t) = w_min + normalize(Radar(t)) * (w_max - w_min)
```

默认参数为：

```text
w_min = 本地 profile 的最小 traffic_weight
w_max = 本地 profile 的最大 traffic_weight
radar_window = latest
profile anomalies = disabled
```

默认关闭本地异常模板，是为了避免“Radar 自身峰谷”和“本地手工异常峰谷”叠加后导致曲线再次失真。如需保留本地异常，可显式增加：

```bash
--radar-keep-profile-anomalies
```

用于外部真实性实验时，应使用同一个 Radar JSON 和同一个窗口：

```bash
npm run experiment:realism -- --out reports/experiment1-external-realism-72x22-radar-fitted --snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --tasks examples/datasets/radar-fitted-starlink-72x22-48-traffic.csv --slices 48 --radar-json reports/experiment1-external-realism-72x22/external/cloudflare-radar/radar-as14593-traffic.json --radar-window latest --external-tle reports/experiment1-external-realism-72x22/external/celestrak-starlink-live.json
```

本项目最新一次校准排查结果：

```text
旧模板数据集 model_vs_external_radar_corr = -0.0803
新 Radar 驱动数据集 model_vs_external_radar_corr = 0.9134
新 Radar 驱动数据集 model_vs_external_radar_mae_normalized = 0.1214
Radar 对齐窗口 = 2026-07-01T11:00:00Z 到 2026-07-03T10:00:00Z
```

注意：Cloudflare Radar AS14593 是公开 ASN 级聚合观测，不是 Starlink 内部 ISL 或卫星节点真实业务日志。因此这里校准的是“业务时间形态”和“峰谷同步关系”，不能宣称模型获得了运营商内部真实流量 trace。
