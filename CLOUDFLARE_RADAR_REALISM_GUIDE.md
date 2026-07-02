# Cloudflare Radar 业务真实性增强说明

本文说明本项目如何借助 Cloudflare Radar 的公开信息增强业务数据集真实性。

## 1. 可以使用的 Cloudflare 内容

当前项目重点参考 Cloudflare Radar 中和 Starlink 公网侧相关的公开聚合维度：

| 来源 | 可用信息 | 在项目中的用途 |
|---|---|---|
| `https://radar.cloudflare.com/as14593` | AS14593 / SPACEX-STARLINK 的 ASN 身份、流量趋势、协议采用、DNS、BGP、HTTP 请求分布入口 | 确定业务校准对象是 Starlink 公网 ASN |
| `https://radar.cloudflare.com/traffic/as14593` | Starlink 范围内的流量趋势、HTTP、移动/桌面、bot/human、内容类型、API traffic、outages/anomalies、地理分布 | 校准业务时间权重、业务类型比例、异常窗口和区域权重 |
| `https://radar.cloudflare.com/quality/as14593` | Starlink 范围内的带宽、延迟、DNS 响应、jitter 和速度测试聚合质量 | 设计时延敏感/吞吐敏感业务类别和退化窗口 |
| `https://radar.cloudflare.com/routing/as14593` | AS14593 的 BGP 前缀、公告、连接关系和路由统计 | 设计跨区域 backbone/background 流和公网出口压力 |
| `https://developers.cloudflare.com/radar/investigate/netflows/` | Cloudflare 边缘路由器观测到的 NetFlows 流量维度 | 支撑“全类型流量趋势”而非只模拟 HTTP |
| `https://developers.cloudflare.com/radar/` | Radar 数据来源、API、授权和公开聚合数据边界 | 说明数据来源和复现边界 |

## 2. 已落实到项目中的增强

配置文件：

```text
traffic-calibration/cloudflare-radar-profile.json
```

生成脚本：

```text
scripts/generateRadarCalibratedTraffic.mjs
```

当前增强点：

- 明确绑定 `AS14593 SPACEX-STARLINK` 作为公网业务画像来源。
- `source_references` 增加 AS14593 overview、traffic、quality、routing 页面。
- `observed_dimensions` 记录可参考的 Radar 维度，包括 traffic trends、HTTP、bot/human、content type、API traffic、outages、anomalies、geography、IP/HTTP version、DNS、quality、BGP。
- `calibration_mapping` 记录每类 Radar 维度如何映射到任务生成逻辑。
- `traffic_classes` 扩展为更贴近公网业务的类别：
  - `human-web`
  - `video-streaming`
  - `interactive-realtime`
  - `api`
  - `background-sync`
  - `software-update`
  - `automated`
  - `dns-control`
- `anomalies` 扩展为晚高峰、流媒体高峰、自动化扫描、区域退化、软件更新波等窗口。
- metadata 中新增：
  - `radar_entity`
  - `observed_dimensions`
  - `calibration_mapping`
  - `quality_model`
  - `task_type_counts`
  - `calibration_class_counts`
  - `calibration_region_counts`
  - `traffic_mbps_by_calibration_class`
  - `realism_boundary`

## 3. 生成命令

8x8 快速实验：

```powershell
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json --profile traffic-calibration/cloudflare-radar-profile.json --out examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv --slices 48
```

47x14 主壳层实验：

```powershell
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-47x14.json --profile traffic-calibration/cloudflare-radar-profile.json --out examples/datasets/radar-calibrated-starlink-main-47x14-48-traffic.csv --slices 48
```

校验：

```powershell
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-main-47x14-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-47x14.json
```

## 4. 真实性边界

可以这样表述：

```text
业务数据集参考 Cloudflare Radar 对 AS14593 / SPACEX-STARLINK 的公开聚合观测维度，
并将 traffic trends、HTTP/API、bot/human、content type、quality、anomalies、
geography 和 routing 维度映射为可投喂卫星网络模型的任务流量。
```

不应这样表述：

```text
本项目使用了 Starlink 真实内部业务 trace。
本项目获得了 Starlink 星间链路真实利用率。
Cloudflare 提供了每颗卫星或每条 ISL 的运营数据。
```

Cloudflare Radar 能增强公网业务画像真实性，但不能替代运营商内部遥测、每星负载、真实 ISL 链路利用率或真实路由表。

## 5. 后续可继续补强

若后续具备 Cloudflare Radar API token，可以增加一个下载脚本，将以下查询结果转成本地 profile：

- AS14593 NetFlows timeseries
- AS14593 HTTP requests timeseries
- AS14593 bot/human summary
- AS14593 content type summary
- AS14593 API traffic summary
- AS14593 Internet Quality timeseries
- AS14593 outage/anomaly events

下载后仍应保存原始查询参数、时间范围、归一化方式和生成时间，保证实验可复现。
