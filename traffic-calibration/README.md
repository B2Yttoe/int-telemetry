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
