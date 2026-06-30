# 第一阶段业务数据集

本目录存放可投喂到 Walker/LEO 真实运行模式的业务任务数据集。数据集用于验证：给定确定性业务输入后，卫星节点状态、星间链路状态、路由、队列、能耗和遥测缓存是否产生合理响应。

## 标准字段

上传文件级契约见 [task-dataset-file.schema.json](../../schemas/task-dataset-file.schema.json)，单条任务字段定义见 [task-dataset.schema.json](../../schemas/task-dataset.schema.json)。

CSV 表头建议保持为：

```csv
task_id,time,start_slice,duration_slices,source,target,node_id,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type
```

关键规则：

- `source` 和 `target` 同时存在时，任务会进入最短路径路由，并驱动链路利用率、拥塞、队列和节点转发负载。
- 只有 `node_id` 时，任务作为本地计算/存储负载投放到指定卫星。
- 路由任务不能同时填写 `node_id`，本地任务不能填写 `source` 或 `target`。
- `traffic_mbps` 大于 0 的任务必须提供合法的 `source` 和 `target`。
- `start_slice` 和 `duration_slices` 决定任务在哪些时间片生效。
- 空业务场景应通过内置 `empty` profile 表示，而不是上传全 0 数据集。
- 相同数据集、相同配置、相同轨道模式应得到确定性结果。

兼容说明：

- 正式模板、冻结清单和论文实验建议使用上面的标准字段。
- 解析器也接受部分外部数据常见别名，例如 `duration` -> `duration_slices`、`src` -> `source`、`dst`/`destination` -> `target`、`node`/`satellite_id` -> `node_id`、`cpu`/`compute` -> `compute_units`、`traffic`/`bandwidth_mbps` -> `traffic_mbps`。
- 别名只用于上传兼容，导出的标准模板和真值元数据会回到标准字段口径；别名归一化会随 `npm run audit:stage1` 和冻结清单一起检查。

## 校验数据集

```bash
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.json
```

输出中 `Errors` 必须为 `0`，否则该数据集不应进入第一阶段验收或实验导出。

## 标准样例

`stage1-standard-traffic.csv` 和 `stage1-standard-traffic.json` 是第一阶段验收用上传数据集，二者表达同一组标准业务，覆盖：

- 跨星路由业务；
- 本地计算任务；
- 遥测/下行业务；
- 突发业务；
- 长时间持续业务。

CSV 文件已经被 `npm run audit:stage1` 纳入自动验收；CSV 与 JSON 文件都会被 `npm run verify:stage1` 纳入总体验证。

## 48 时间片 ML 扩展样例

`stage1-ml-48-traffic.csv` 是为了后续“根据当前时间片预测下一时间片节点/链路状态”的机器学习任务准备的扩展业务数据集。它不替代标准验收数据集，而是用于生成更长时间范围、更连续业务扰动的训练样本。

该数据集面向当前默认 `48` 个时间片配置，包含：

- 长时背景流：覆盖大部分或全部 48 个时间片，用于形成持续链路负载；
- 周期遥测流：每隔 4 个时间片投放一次，用于制造可学习的周期性；
- 多批次突发流：在 T06/T18/T30/T40 附近制造局部拥塞和队列变化；
- 本地计算任务：在不同时间片投放到不同卫星，用于驱动 CPU/GPU/内存/能耗变化；
- 热点路由任务：多条业务流指向同一热点卫星，用于形成局部节点与链路压力。

推荐校验和导出方式：

```bash
npm run validate:dataset -- --tasks examples/datasets/stage1-ml-48-traffic.csv
npm run export:scenario -- --tasks examples/datasets/stage1-ml-48-traffic.csv --orbit tle-sgp4 --mode operational --out exports/ml-48-traffic
```

如果要生成对应的 INT 遥测过程数据：

```bash
npm run int:experiment -- --tasks examples/datasets/stage1-ml-48-traffic.csv --out stage2-int/runs/ml-48-traffic --orbit tle-sgp4 --mode operational --algorithm path-balance
```

## 真实快照 48 时间片业务数据集

`real-starlink-72x22-ml-48-traffic.csv` 和 `real-starlink-8x8-ml-48-traffic.csv` 面向 `real-tle-sgp4` 模式生成。它们沿用 48 时间片的长时业务、周期业务、突发业务和本地计算任务结构，但节点编号会按照真实快照的 `planes x satellites_per_plane` 自动展开，因此不会把 8x8 的节点误投到 72x22 场景，或者把 72x22 节点误投到 8x8 调试场景。

生成命令：

```bash
npm run generate:real-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --out examples/datasets/real-starlink-72x22-ml-48-traffic.csv --slices 48
npm run generate:real-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json --out examples/datasets/real-starlink-8x8-ml-48-traffic.csv --slices 48
```

校验命令必须带上对应快照，这样脚本会按快照中的真实平面数和槽位数校验节点编号：

```bash
npm run validate:dataset -- --tasks examples/datasets/real-starlink-72x22-ml-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
npm run validate:dataset -- --tasks examples/datasets/real-starlink-8x8-ml-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json
```

当前两份数据集均包含 174 条任务，其中 138 条为跨星路由任务、36 条为本地计算任务，校验结果为 `Warnings: 0`、`Errors: 0`。72x22 真实快照导出命令：

```bash
npm run export:scenario -- --tasks examples/datasets/real-starlink-72x22-ml-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --mode operational --out exports/real-tle-starlink-72x22-ml-48
```

8x8 真实快照 INT 烟测命令：

```bash
npm run int:experiment -- --tasks examples/datasets/real-starlink-8x8-ml-48-traffic.csv --orbit real-tle-sgp4 --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json --mode operational --algorithm path-balance --out stage2-int/runs/real-tle-8x8-traffic-global-oam --skip-verify
```

## Cloudflare Radar 校准业务数据集

`radar-calibrated-starlink-72x22-48-traffic.csv` 和 `radar-calibrated-starlink-8x8-48-traffic.csv` 是为了提升业务输入真实性新增的数据集。它们不是 Cloudflare Radar 原始日志，也不是 Starlink 真实运营流量，而是参考 Cloudflare Radar 公开互联网流量维度构造的校准合成业务，包含：

- 按 48 时间片变化的互联网流量强度曲线；
- 北美、欧洲、东亚、南美、大洋洲等区域需求权重；
- human web、API、background sync、automated、DNS/control 等业务类型；
- 晚间人类流量高峰、自动化扫描突发、区域流量下降等异常窗口；
- 与真实 TLE 快照尺寸绑定的节点编号和 metadata。

生成命令：

```bash
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json --profile traffic-calibration/cloudflare-radar-profile.json --out examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --slices 48
npm run generate:radar-traffic -- --snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json --profile traffic-calibration/cloudflare-radar-profile.json --out examples/datasets/radar-calibrated-starlink-8x8-48-traffic.csv --slices 48
```

校验命令：

```bash
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-72x22.json
npm run validate:dataset -- --tasks examples/datasets/radar-calibrated-starlink-8x8-48-traffic.csv --tle-snapshot data/tle-snapshots/celestrak-starlink-real-walker-8x8.json
```

当前生成结果：

```text
72x22 fingerprint: d6d36270
8x8 fingerprint: 2ccc391f
tasks: 755
routed_tasks: 683
local_tasks: 72
warnings: 0
errors: 0
```

完整说明见 [traffic-calibration/README.md](../../traffic-calibration/README.md)。

## 场景模板

`templates/` 目录由以下命令生成：

```bash
npm run export:templates
```

生成文件包括每个场景的 CSV 与 JSON 模板：

- `empty.csv`
- `empty.json`
- `low-load.csv`
- `low-load.json`
- `normal.csv`
- `normal.json`
- `high-load.csv`
- `high-load.json`
- `hotspot.csv`
- `hotspot.json`
- `burst.csv`
- `burst.json`
- `long-duration.csv`
- `long-duration.json`
- `manifest.json`

这些模板与内置业务 profile 使用同一套任务生成逻辑，并且会通过标准数据集校验。JSON 模板采用 `{ "tasks": [...] }` 文件级结构；审计脚本还会额外验证纯数组 JSON 上传形式。用户可以直接上传模板，也可以复制后修改其中的节点、时间片、流量和资源需求，用于构造可复现实验。
