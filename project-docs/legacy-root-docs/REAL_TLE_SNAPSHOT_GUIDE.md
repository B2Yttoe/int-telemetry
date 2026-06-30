# 真实 TLE / GP 快照接入指南

本项目现在支持把公开轨道目录接入为 `real-tle-sgp4` 模式。该模式不会再使用合成 Walker TLE，而是从 CelesTrak 公开 GP/OMM JSON 中读取真实卫星轨道参数，再用 SGP4 传播每个时间片的位置、速度、经纬度和高度。

## 当前实现范围

- 数据源：CelesTrak GP JSON。
- 默认星座：Starlink。
- 默认真实规模快照：`72 x 22 = 1584` 颗卫星。
- 内部编号仍使用 `Pxx-Syy`，用于兼容现有业务数据集、路由、链路和 INT 遥测流程。
- 每颗卫星保留真实 `NORAD ID`、`satellite_name`、`COSPAR ID`、`epoch`、`inclination`、`RAAN`、`eccentricity`、`argument_of_perigee`、`mean_anomaly`、`mean_motion`、`BSTAR` 和原始 `raw_omm`。
- 真实快照会写入 fingerprint，便于复现实验。

## 生成真实快照

默认命令：

```bash
npm run tle:fetch -- --group STARLINK --planes 72 --satellites-per-plane 22 --out data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
```

当前已经生成的快照：

```text
data/tle-snapshots/celestrak-starlink-raw-gp.json
data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
data/tle-snapshots/celestrak-starlink-real-walker-8x8.json
```

说明：

- `raw-gp.json` 是从 CelesTrak 获取的原始公开目录缓存。
- `72x22.json` 是面向真实规模仿真的 Starlink-like Walker shell 快照。
- `8x8.json` 是快速调试和前端预览用的小规模真实轨道快照。

当前 72x22 快照摘要：

```text
source_url: https://celestrak.org/NORAD/elements/gp.php?NAME=STARLINK&FORMAT=JSON
downloaded_at: 2026-06-26T09:50:33.467Z
catalog_count: 10658
shell_count: 3264
selected_count: 1584
layout: 72 x 22
mean_altitude_km: 490.2
mean_inclination_deg: 43.0017
fingerprint: 77a8ac15
```

CelesTrak 会限制重复下载。如果短时间内再次请求同一数据源，可能返回“数据未更新”的提示。此时可以使用本地缓存：

```bash
npm run tle:fetch -- --cache-only --group STARLINK --planes 72 --satellites-per-plane 22 --out data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
```

## 验证快照

验证内置小样例：

```bash
npm run tle:verify
```

验证真实 Starlink 快照：

```bash
npm run tle:verify -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
```

验证通过时会输出：

```text
selected_count: 1584
layout: 72 x 22
fingerprint: ...
```

## 用真实快照导出第一阶段真值

小规模快速预览：

```bash
npm run export:scenario -- --profile empty --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json --mode operational --slices 2 --out exports/real-tle-starlink-8x8-smoke
```

真实规模烟测：

```bash
npm run export:scenario -- --profile empty --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --mode operational --slices 1 --out exports/real-tle-starlink-72x22-smoke
```

完整 48 时间片导出可以去掉 `--slices 1`，但数据量会明显增大：

```bash
npm run export:scenario -- --tasks examples/datasets/real-starlink-72x22-ml-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --mode operational --out exports/real-tle-starlink-72x22-ml-48
```

本次 72x22、48 时间片导出结果：

```text
out: exports/real-tle-starlink-72x22-ml-48
nodes.csv rows: 76032
links.csv rows: 151008
routes.csv rows: 1554
metrics.csv rows: 48
truth_fingerprint: 0b495517
```

## 接入 INT 实验

INT 实验脚本已经支持透传真实快照：

```bash
npm run int:experiment -- --tasks examples/datasets/real-starlink-8x8-ml-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json --mode operational --algorithm path-balance --out stage2-int/runs/real-tle-8x8-traffic-global-oam --skip-verify
```

建议先用 `8x8` 快照验证遥测流程，再扩大到 `72x22`。真实规模下 probe-int 的路径规划、逐跳记录和过程可视化文件都会显著增大。

本次 8x8 真实轨道 INT 烟测结果：

```text
run: stage2-int/runs/real-tle-8x8-traffic-global-oam
process slices: 48
probe-int node coverage: 46.03%
probe-int link coverage: 59.46%
probe reports: 769
downlinked reports: 380
dropped reports: 389
main drop reason: no-reporting-path
```

注意：真实轨道快照下，probe 能在星间网络中采集状态，并不代表 Ground OAM 一定能在同一时间片收到所有报告。当前地面站数量、地理位置、仰角门限和星地回传窗口会直接影响 `delivered reports`。因此真实轨道模式下可能出现 `full_time_step_pass = false`，这通常表示回传窗口不足或 reporting path 不可达，而不是 TLE/SGP4 接入失败。项目已经加入一组代表性的全球 OAM/gateway 地面站来改善回传窗口，但仍保留真实模式下的窗口约束，不强行把覆盖率调成演示式 100%。

## 快照如何映射成 Walker 拓扑

CelesTrak 公开 GP 数据不会直接给出 `plane_id` 和 `slot_id`。项目采用以下规则生成可仿真的 Walker-like 拓扑：

1. 从公开目录中过滤可传播的 active 记录。
2. 按倾角和估算高度选择最大壳层。
3. 按 RAAN 聚类为轨道面。
4. 在每个轨道面内按 `argument_of_perigee + mean_anomaly` 排序。
5. 从每个轨道面均匀抽样指定数量的槽位。
6. 重新映射为内部编号 `Pxx-Syy`，同时保留真实 NORAD 和原始 OMM 字段。

这样做的好处是：现有链路、业务、路由和 INT 管线不需要推倒重来，同时轨道传播由真实公开 GP/OMM 参数驱动。

## 注意事项

- `real-tle-sgp4` 提升的是轨道真实性，不等于真实遥测数据。
- 公开 TLE/GP 快照会随时间更新，实验复现时应固定快照文件和 fingerprint。
- 全量真实 Starlink 目录超过一万条，当前仿真建议先使用一个 Walker-like shell，例如 `72x22`。
- 前端实时 3D 可视化不建议默认加载 1584 颗以上卫星；论文复现实验可以优先使用离线导出和 INT 结果文件。
