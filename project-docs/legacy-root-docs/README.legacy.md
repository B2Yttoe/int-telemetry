# Walker-Star LEO 卫星网络仿真仪表盘

真实公开轨道快照接入说明见 [REAL_TLE_SNAPSHOT_GUIDE.md](./REAL_TLE_SNAPSHOT_GUIDE.md)。该指南介绍了如何从 CelesTrak 获取 Starlink GP/OMM JSON、生成 `real-tle-sgp4` 快照、验证快照，并把真实轨道快照用于第一阶段真值导出和第二阶段 INT 实验。

本项目实现了一个可配置、可视化、按时间片演化的 LEO 卫星网络仿真系统。系统以 Walker-Star 星座为基础，在浏览器中展示三维地球、轨道面、卫星节点、星间链路、节点状态和链路状态，用于观察低轨卫星网络拓扑随时间变化的过程。

## 收尾验收状态

当前项目已经完成从高仿真卫星网络模型到第二阶段 INT 全网遥测复现的整体闭环：

```text
外部业务数据集
-> 输入数据集校验
-> 第一阶段卫星星座真值快照
-> INT / probe-int 全网遥测
-> Ground OAM 重构节点和链路状态
-> INT 全网状态交付清单
-> 准确率报告
-> 总体验收报告
```

推荐使用总体验收命令确认当前项目状态：

```bash
npm run verify:goal
```

当前总体验收报告：

```text
reports/goal/goal-e2e-verification.json
reports/goal/goal-e2e-verification.md
```

当前已验证结果：

```text
总体验收：19/19 通过
第一阶段模型验收：100/100
INT 复验：80/80
probe-int 节点覆盖率：100%
probe-int 链路覆盖率：100%
逐时间片审计：24/24
```

详细复现实验步骤见 [EXPERIMENT_REPRODUCTION_GUIDE.md](./EXPERIMENT_REPRODUCTION_GUIDE.md)。

## 文档导航

| 文档 | 用途 |
|---|---|
| [EXPERIMENT_REPRODUCTION_GUIDE.md](./EXPERIMENT_REPRODUCTION_GUIDE.md) | 从安装、运行、验收到读取产物的完整复现手册 |
| [USAGE_GUIDE.md](./USAGE_GUIDE.md) | 仪表盘、任务数据、导出和仿真参数的使用指南 |
| [STAGE1_USER_GUIDE.md](./STAGE1_USER_GUIDE.md) | 第一阶段仿真模型、真值导出和参数意义说明 |
| [DATASET_FIELD_REFERENCE.md](./DATASET_FIELD_REFERENCE.md) | 业务输入、第一阶段真值、INT 遥测和 Ground OAM 重构数据集字段说明 |
| [REAL_TLE_SNAPSHOT_GUIDE.md](./REAL_TLE_SNAPSHOT_GUIDE.md) | CelesTrak 公开 GP/OMM 快照、真实 TLE + SGP4 模式和真实规模导出说明 |
| [traffic-calibration/README.md](./traffic-calibration/README.md) | Cloudflare Radar 统计特征校准业务数据集的生成、边界和复现实验说明 |
| [stage2-int/README.md](./stage2-int/README.md) | 第二阶段 INT 遥测设计、实验命令和产物说明 |

## 项目实现了什么

项目当前完成了以下内容：

- 生成一个规则化 Walker-Star 低轨卫星星座。
- 将轨道面按 `180° / planes` 均匀划分，符合 Walker-Star 极轨或近极轨构型中无向轨道平面平分 180° 的建模方式。
- 每个轨道面内均匀部署固定数量卫星，卫星沿各自轨道持续运动。
- 支持 `解析 Walker` 与 `TLE + SGP4` 两种轨道传播模式。
- 为每颗卫星节点维护可随时间变化的运行状态。
- 为每条星间链路维护可随时间变化的链路状态。
- 支持多个时间片，每个时间片都会重新计算卫星位置、链路距离、链路状态和网络可用率。
- 支持连续运动模式和时间片快照模式。
- 构建了三维轨道拓扑和二维时间片拓扑两个视图，用于同时观察空间结构和展平后的链路连通关系。
- 支持外部业务数据集输入、校验、快照留档和 fingerprint 绑定。
- 支持第二阶段 INT 遥测实验，包含 traffic-int、probe-int、reporting path、Ground OAM 重构和准确率检验。
- 支持导出由 INT 遥测得到的全网节点状态和链路状态数据集。
- 支持生成输入校验报告、交付清单、准确率报告、文件完整性索引和项目总体验收报告。

项目的核心目标不是做静态拓扑图，而是让卫星网络在时间维度上发生变化，并将这种变化直接展示出来。

## 卫星网络仿真的内容

### 星座模型

当前星座模型在 `src/config/walkerNetworkConfig.ts` 中配置，默认参数为：

- 轨道面数量：`8`
- 每个轨道面卫星数量：`8`
- 卫星总数：`64`
- 轨道高度：`1200 km`
- 轨道倾角：`86.4°`
- 轨道周期：约 `109.3 min`
- 时间片数量：`24`
- 时间片步长：`5 min`

卫星编号采用内部规则：

```text
P01-S01
P01-S02
...
P08-S08
```

其中 `Pxx` 表示轨道面，`Sxx` 表示该轨道面内的槽位。

### 轨道面划分

Walker-Star 拓扑中，轨道面按 180° 平分，而不是按 360° 平分。

例如默认 `planes = 8` 时：

```text
相邻轨道面角度间隔 = 180° / 8 = 22.5°
```

因此轨道面 RAAN 近似为：

```text
0°, 22.5°, 45°, 67.5°, 90°, 112.5°, 135°, 157.5°
```

三维图中会为不同轨道面使用不同颜色，并支持单独开关轨道面显示。

### 二维时间片拓扑

仪表盘新增了二维平面拓扑视图：

- 横向按轨道面 `P1...Pn` 展开。
- 纵向按轨道面内槽位 `S1...Sm` 展开。
- 只绘制当前时间片处于连接状态的链路。
- 轨内链路和轨间链路使用不同颜色区分。
- 节点颜色跟随当前节点健康状态变化。
- 点击二维图中的节点或链路，会同步更新右侧详情面板。
- 二维图自带时间片按钮，可以直接查看不同时间点的拓扑快照。

该视图与三维场景使用同一份 `NetworkSlice` 数据，因此在 `TLE + SGP4` 模式下，二维拓扑展示的是由 SGP4 传播位置进一步计算出的当前链路状态。

### 卫星运动

卫星位置支持两种轨道模型：

- `解析 Walker`：由 Walker 壳层参数直接计算圆轨道位置，轨道面、槽位和相位完全规则，适合观察拓扑结构。
- `TLE + SGP4`：由当前 Walker 壳层参数生成一组合成 TLE，再使用 `satellite.js` 的 SGP4 传播得到每个时间片的位置、速度、经纬度和高度。
- `真实 TLE + SGP4`：通过 `--tle-snapshot` 接入 CelesTrak GP/OMM JSON 快照，保留每颗卫星的 NORAD、COSPAR、epoch、RAAN、倾角、偏心率、近地点幅角、平近点角、平均运动和 BSTAR，并用 SGP4 逐时间片传播。
- 两种模式都保留每个轨道面独立 RAAN、轨道面内均匀槽位和 Walker 相位规则。
- 连续运动模式下，卫星会沿轨道持续运动。
- 场景以地球为中心，卫星网络整体随参考系横向漂移，用于表达地球自转参考系下的相对运动。

当前默认前端演示仍优先使用可预测的合成 `TLE + SGP4`，便于保持拓扑清晰、规则和可解释；离线实验和真实规模数据集可以切换到 `真实 TLE + SGP4`，使用固定 fingerprint 的公开快照复现 Starlink-like Walker shell。

## 节点状态仿真

每颗卫星节点携带状态，状态会随时间片变化。节点状态包括：

- `mode`：节点模式，包含 `nominal`、`warning`、`degraded`
- `batteryPercent`：电量百分比
- `cpuLoadPercent`：CPU 负载
- `temperatureC`：温度
- `queueDepth`：队列深度

节点状态不是完全随机生成，而是基于轨道面、槽位和时间片生成周期性波动，使同一颗卫星在不同时间片表现出不同负载、温度和队列状态。

当 CPU、温度、电量或队列深度超过阈值时，节点会进入告警或降级状态。

## 链路状态仿真

项目支持两类星间链路：

- 轨内链路：同一轨道面内相邻卫星之间的链路
- 轨间链路：相邻轨道面卫星之间的链路

每条链路携带状态：

- `status`：`up`、`warning`、`down`
- `bandwidthMbps`：带宽
- `latencyMs`：时延
- `utilizationPercent`：链路利用率
- `distanceKm`：链路两端卫星距离
- `restrictionReason`：断链原因

### 轨内链路

轨内链路按同一轨道面内的环形邻接关系生成：

```text
S01 - S02 - S03 - ... - S08 - S01
```

轨内链路被视为稳定链路，会一直存在。它可能因为利用率过高进入 `warning`，但不会因为轨间距离阈值或极区规则断开。

### 轨间链路

轨间链路只在相邻轨道面之间生成，且不跨 Walker-Star seam 边界连接首末轨道面。

生成规则包括：

- 只在相邻轨道面之间尝试建立轨间链路。
- 每颗卫星最多拥有 4 条链路。
- 一颗卫星通常包含 2 条轨内链路，最多再拥有 2 条轨间链路。
- 卫星之间不会重复建立多条链路。
- 轨间链路不再固定连接同槽位卫星，而是在相邻轨道面内按当前时间片的空间距离做最近邻匹配。
- 同一颗卫星对同一侧相邻轨道面最多建立一条轨间链路。
- 当轨间链路距离超过阈值时，该链路进入断开状态。
- 每条已连接 ISL 链路都会占用源端和目的端对应的方向天线。

默认轨间距离阈值为：

```text
interPlane.maxDistanceKm = 3600 km
```

该阈值已经高于当前 1200 km 壳层、8 个轨道面配置下赤道附近约 2950 km 的相邻轨道面距离，因此赤道附近不会再仅因为几何距离过大而断开。链路距离接近阈值时会进入 `warning`；超过阈值时，链路状态变为 `down`，断链原因标记为 `distance-threshold`。

### 天线模型

项目新增了独立的 `src/simulation/antenna.ts` 天线建模模块。每颗卫星默认携带 5 个天线对象：

```text
ISL: front / back / left / right
SGL: earth-facing
```

每个天线包含编号、类型、频段、增益、波束宽度、最大通信距离、最大发射功率、带宽、最大同时波束数、指向范围、转向速度和当前状态等字段。

ISL 天线规则：

- `front` / `back` 分别服务轨内前向和后向链路。
- `left` / `right` 分别服务左右相邻轨道面的轨间链路。
- 每个 ISL 天线最大同时波束数默认为 `1`，因此一颗卫星最多同时建立 4 条 ISL 链路。
- 如果链路距离超过 ISL 天线最大通信距离，链路会断开，原因标记为 `antenna-range`。
- 每个时间片会记录每个天线上一时刻指向的目标和局部轨道坐标系方向；当目标变化时，按转向角、转向速度和捕获时间计算切换时延。

SGL 天线规则：

- 每颗卫星默认有 1 个地向 Ka 频段星地天线。
- 每个时间片会计算卫星到配置内地面站的仰角和斜距。
- 只有仰角高于门限且距离不超过 SGL 天线最大通信距离时，星地窗口才可用。
- 当多个地面站同时可见时，当前模型优先占用仰角最高的窗口。
- 可用窗口会给出当前上报容量，用于后续 INT 遥测数据回传建模。

天线指向与切换约束：

```text
theta_slew = angle(previous_boresight, current_target)
t_switch = t_acquisition + theta_slew / slew_rate
availability = clip(1 - t_switch / time_slice_seconds, 0, 1)
L_pointing,dynamic = 12 * (theta_error / beamwidth)^2
theta_error = pointing_jitter + angular_rate * tracking_loop_lag
```

其中指向方向使用卫星局部轨道坐标系计算，避免把整条轨道在惯性系中的旋转误判为轨内链路反复重指向。`availability` 会直接缩放链路有效容量；如果低于 `pointingModel.minAvailableFraction`，链路断开并标记为 `pointing-switch`。仪表盘链路详情会展示总指向损耗、动态指向损耗、源/目的端指向误差、切换时延和当前时间片可用比例。

多普勒频移约束：

```text
v_radial = dot(v_rx - v_tx, unit(r_rx - r_tx))
f_doppler = f_carrier * v_radial / c
f_residual = max(f_floor, abs(f_doppler) * residual_fraction)
             + max(abs(f_doppler) - compensation_range, 0)
L_doppler = L_doppler,max * min(f_residual / f_residual,max, 1)^2
```

ISL 使用两颗卫星的 ECI 位置和速度计算径向相对速度；SGL 使用卫星 ECI 速度和随地球自转的地面站 ECI 速度计算星地径向速度。`L_doppler` 会进入链路总损耗，频偏超过接收机补偿范围或残差超过门限时，链路断开并标记为 `doppler-shift`。仪表盘会展示径向速度、多普勒频移、残差、跟踪裕量和多普勒损耗。

接收端环境噪声约束：

```text
theta_sun = angle(receiver_boresight, sun_direction_eci)
T_sun,coupled = T_sun * coupling(theta_sun, beamwidth)
T_ext = T_quiet_sky + T_sun,coupled
T_sys = T_ref + T_ext
N_env(dB) = 10log10(T_sys / T_ref)
```

太阳方向由当前仿真时间的太阳 ECI 向量计算，SGL 使用地面站接收波束与太阳方向的夹角，ISL 使用接收星间天线波束与太阳方向的夹角。`N_env` 会抬高链路噪声功率，从而降低 SNR/SINR、MCS 和有效容量。仪表盘会显示环境噪声增量、太阳噪声温度、太阳夹角和系统噪声温度。

对于激光 ISL，项目进一步加入太阳规避角约束。接收端波束与太阳方向夹角小于 `solarExclusionAngleDeg` 时，链路直接断开并标记为 `solar-interference`；夹角位于规避角和告警角之间时，按二次函数叠加太阳干扰损耗：

```text
margin_sun = theta_sun - theta_exclusion
L_sun = L_sun,max * ((theta_warning - max(theta_sun, theta_exclusion)) / (theta_warning - theta_exclusion))^2
```

这使太阳干扰不再是随机扰动，而是由当前太阳方向、卫星位置和接收波束几何共同决定。仪表盘会显示太阳规避裕量、太阳干扰损耗以及是否闭锁。

### 链路预算

项目新增了独立的 `src/simulation/linkBudget.ts` 链路预算模块，用于把链路状态从单纯几何约束推进到一阶通信物理约束。

当前计算包括：

```text
FSPL(dB) = 92.45 + 20log10(d_km) + 20log10(f_GHz)
Pr(dBm) = Pt(dBm) + Gt(dBi) + Gr(dBi) - Ltotal(dB)
N(dBm) = -174 dBm/Hz + 10log10(B_Hz) + NF(dB) + N_env(dB)
SNR(dB) = Pr(dBm) - N(dBm)
C = B log2(1 + SNR)
```

其中 `Ltotal` 包括自由空间损耗、实现损耗、大气损耗、极化损耗、指向损耗和多普勒残差损耗。每条 ISL 链路会保存频率、发射功率、天线增益、自由空间损耗、接收功率、噪声功率、SNR、链路裕量和容量。链路容量会写回 `bandwidthMbps`，因此后续任务流量和拥塞计算可以直接使用该物理层容量。

当前版本还加入了 ISL 与 SGL 干扰约束。仿真会在每个时间片内把所有活跃 ISL 发射端作为潜在干扰源，按发射端离轴角、接收端离轴角、旁瓣抑制、后瓣抑制、极化隔离、自干扰隔离、频率复用隔离和传播损耗计算聚合干扰功率：

```text
I_total = sum(Pi)
SINR = S / (N + I_total)
C_interference = B log2(1 + SINR)
```

链路最终容量使用 `C_interference` 与天线带宽上限的较小值；链路状态判定也使用 SINR 裕量，而不是只看热噪声 SNR。这样干扰不会再是随机扰动，而是由当前拓扑几何、频率复用、天线方向图和物理功率预算共同推导出来。

频率复用采用网络级简化模型：每条 ISL/SGL 链路分配一个信道编号，干扰源按信道差分为同信道、邻信道和频率间隔滤除三类。模型只使用 `coChannelIsolationDb`、`adjacentChannelIsolationDb`、邻频滚降和最大邻频间隔，不模拟完整频谱掩模、滤波器群时延或真实波束调度，以避免复杂度压过 Walker 拓扑和 INT 遥测主题。

SGL 下行干扰会在星地窗口全部生成后统一回算。只有当前时间片真实占用并处于 `available` 的星地下行会作为发射源；对每个地面接收窗口，系统会计算其他卫星到该地面站的仰角、路径损耗、发射端离轴增益和地面站接收端离轴增益：

```text
I_sgl = sum(Pt_sat + Gt_offaxis + Gr_ground_offaxis - FSPL - L_atm - L_iso)
SINR_sgl = S / (N + I_sgl)
```

其中地面站接收端方向图使用配置的地面天线波束宽度和旁瓣抑制近似。SGL 的 SINR 会继续驱动 MCS、PER 和上报容量，因此多个卫星同时下传时，地面遥测回传容量会受到当前全网几何和发射状态约束。

星地链路还加入了仰角相关的大气与天气衰减。每个地面站可以配置外部天气条件：雨强、雨层高度、气体天顶损耗、云液态水含量和闪烁衰落。当前版本支持 `weatherTimeline`，即按分钟给出的已知外部天气样本；仿真时间落在两个样本之间时，按线性插值得到当前时间片天气：

```text
W(t) = W0 + (W1 - W0) * (t - t0) / (t1 - t0)
```

每个时间片会按插值得到的当前天气和当前卫星仰角计算斜路径损耗：

```text
gamma_R = k * R^alpha
L_rain = gamma_R * L_slant * r
L_gas = L_gas,zenith / sin(elevation)
L_cloud = K_cloud * L_cloud_water / sin(elevation)
L_atm = L_rain + L_gas + L_cloud + L_scintillation
```

其中 `R` 是当前时间片插值得到的地面站雨强，`k/alpha` 是雨衰经验系数，`r` 是斜路径缩短因子。SGL 链路预算会保存总大气损耗、雨衰、气体吸收、云衰和闪烁损耗；星地窗口会保存当前雨强、云液态水含量和闪烁衰落。这些损耗会直接降低接收功率、SNR 和上报容量。

在此基础上，项目新增了自适应调制编码和误包率估计。ISL 与 SGL 分别配置 MCS 表，每个 MCS 包括调制方式、码率、频谱效率、最低 SINR 和编码增益。链路预算先按 SINR 计算可达 MCS，再用 AWGN 下常用的误码率近似估计包错误率：

```text
Eb/N0(dB) = SINR(dB) - 10log10(spectral_efficiency)
BER_BPSK/QPSK = 0.5 * erfc(sqrt(Eb/N0))
PER = 1 - (1 - BER) ^ packet_bits
C_effective = min(C_shannon, C_mcs, C_antenna) * (1 - PER) * availability
```

系统会选择满足目标 PER 的最高频谱效率 MCS；如果边缘链路使用高阶调制会超过目标 PER，就会自动降到更稳健的 MCS。这样链路吞吐不再只是 Shannon 上界，而是受到调制编码和包错误率共同约束。

默认近似参数：

```text
ISL: 1550 nm 光链路近似，frequencyGhz = 193500，channelBandwidthMhz = 2500
SGL: Ka 下行近似，frequencyGhz = 20，channelBandwidthMhz = 600
ISL 最低 SNR：6 dB
SGL 最低 SNR：5 dB
ISL 旁瓣抑制：35 dB，自干扰隔离：110 dB，4 信道复用，邻信道隔离：24 dB
SGL 3 信道复用，邻信道隔离：28 dB
SGL 旁瓣抑制：32 dB，地面站接收波束宽度：2.4°
SGL 雨衰：k = 0.075，alpha = 1.1，按地面站雨强和仰角实时计算
MCS 目标包错误率：1e-3，默认包长 1024 bytes
天线捕获时间：2 s，跟踪环路滞后：0.8 s
ISL 指向抖动：0.05°，SGL 指向抖动：0.15°
最低时间片可用比例：0.85，告警可用比例：0.96
ISL 多普勒补偿范围：12 GHz，残差比例：0.0005，最大残差：25 MHz
SGL 多普勒补偿范围：900 kHz，残差比例：0.02，最大残差：60 kHz
ISL 安静天空噪声：5 K，SGL 安静天空噪声：25 K
SGL 太阳噪声温度近似：120000 K，按太阳夹角和接收波束耦合
ISL 太阳规避角：6°，太阳告警角：12°，最大太阳干扰损耗：6 dB
地面站天气时间序列雨强范围：0.02-28 mm/h，按时间片线性插值
```

参考来源：

- 自由空间损耗公式参考 ITU-R P.525：<https://www.itu.int/rec/R-REC-P.525/en>
- 卫星天线参考方向图可参考 ITU-R S.672：<https://www.itu.int/rec/R-REC-S.672/en>
- 星地雨衰与传播损耗建模可参考 ITU-R P.618、P.838、P.676：<https://www.itu.int/rec/R-REC-P.618/en>、<https://www.itu.int/rec/R-REC-P.838/en>、<https://www.itu.int/rec/R-REC-P.676/en>
- 自适应调制编码工程背景可参考 ETSI DVB-S2/S2X 标准族：<https://www.etsi.org/deliver/etsi_en/302300_302399/302307/>
- Starlink 公开材料中将星间通信称为 space lasers，可作为本项目 ISL 激光链路抽象的公开背景：<https://www.starlink.com/technology>
- Ka 频段星地链路的频率背景参考 FCC SpaceX Gen2 Starlink 授权文件：<https://docs.fcc.gov/public/attachments/FCC-22-91A1.pdf>

### 极地区域限制

项目加入了极地区域检测限制，用于模拟 LEO 星座在高纬地区关闭或限制轨间链路的情况。

默认极区阈值为：

```text
polarRegion.latitudeDeg = 66.5°
```

规则如下：

- 该限制只作用于轨间链路。
- 当轨间链路任意一端卫星进入 `±66.5°` 以内的极地区域时，该轨间链路断开。
- 断链原因标记为 `polar-region`。
- 当卫星离开极区后，轨间链路会重新按照距离阈值判断是否恢复。

因此，在不同时间片中，同一条轨间链路可能经历：

```text
连接 -> 极区断开 -> 离开极区后重新连接
```

这也是当前仿真中拓扑动态变化的主要来源之一。

## 三维仪表盘

仪表盘由 React、Three.js 和 Vite 实现，主要界面包括：

- 三维地球
- LEO 卫星节点
- 彩色轨道面
- 星间链路
- 极区纬度参考圈
- 节点详情面板
- 链路详情面板
- 二维时间片拓扑图
- 节点矩阵
- 链路状态表
- 网络统计卡片
- 时间片选择器
- 显示设置开关

### 三维拓扑图

三维拓扑图展示真实空间感的卫星网络结构：

- 地球位于场景中心。
- 卫星环绕地球运动。
- 不同轨道面使用不同颜色。
- 轨道面可以显示或隐藏。
- 节点可以显示或隐藏。
- 链路可以显示或隐藏。
- 用户可以旋转、缩放三维场景。
- 点击卫星节点可以查看该节点状态。

### 二维拓扑图

二维拓扑图将同一时间片的卫星网络展平成平面视图，适合快速比较不同时间点的连通变化：

- 轨道面以列展示。
- 轨道槽位以行展示。
- 轨内链路、轨间链路分别用不同颜色展示。
- 断开的链路不绘制，保证二维图与链路状态表一致。
- 极区节点会用虚线轮廓提示，方便观察极区限制导致的轨间断链。

### 时间片快照

仪表盘支持两种时间模式：

- 运动模式：卫星持续运动，用于观察动态轨道拓扑。
- 快照模式：点击 `T00`、`T01`、`T02` 等时间片后，场景固定到该时间片。

在快照模式下：

- 节点位置固定为该时间片的位置。
- 链路表显示该时间片下所有链路状态。
- 三维拓扑图只显示处于连接或告警状态的链路。
- 已断开的链路不会继续显示在三维图中，避免图上链路状态和表格状态不一致。

## 配置说明

主要配置文件为：

```text
src/config/walkerNetworkConfig.ts
```

配置项包括：

- `constellation`：星座规模和轨道参数
- `time`：时间片数量和步长
- `interPlane`：轨间链路阈值、告警余量、单节点最大链路数
- `polarRegion`：极区限制开关和纬度阈值
- `antennaModel`：ISL/SGL 天线频段、增益、波束宽度、最大距离、功率、带宽和波束数
- `linkBudget`：ISL/SGL 频率、信道带宽、噪声系数、链路损耗、最低 SNR 和最低容量
- `interferenceModel`：ISL/SGL 频率复用、同频/邻频隔离、旁瓣/后瓣抑制、自干扰隔离、地面站接收波束和最小干扰功率
- `pointingModel`：天线捕获时间、跟踪滞后、最低可用比例、ISL/SGL 指向抖动
- `dopplerModel`：ISL/SGL 多普勒补偿范围、残差比例、残差门限和损耗上限
- `noiseModel`：ISL/SGL 安静天空温度、太阳噪声温度、太阳角半径、波束耦合、ISL 太阳规避角和太阳干扰损耗
- `atmosphericModel`：SGL 雨衰、气体、云衰和闪烁损耗近似参数
- `adaptiveCoding`：ISL/SGL MCS 表、包长和目标误包率
- `groundStations`：地面站经纬度、高度、最小仰角、默认天气和 `weatherTimeline` 外部天气样本
- `nodeStateDefaults`：节点默认状态
- `linkStateDefaults`：链路默认状态
- `stateProfiles`：节点和链路状态随时间波动的幅度

可以通过修改该配置文件调整星座规模、链路规则和状态波动。

## 运行方式

安装依赖：

```bash
npm install
```

启动开发服务器：

```bash
npm run dev
```

构建生产版本：

```bash
npm run build
```

如果本机 npm 全局缓存目录权限受限，可以使用项目内缓存：

```bash
npm install --cache .\.npm-cache
```

## 当前实现边界

当前版本侧重于 Walker-Star 网络拓扑、链路预算、任务流量和可视化遥测仿真。它已经包含一阶通信物理、时间片级业务积压模型，以及 CelesTrak 公开 GP/OMM 快照接入能力，但暂未包含以下高保真细节：

- 未接入运营商私有星座调度、真实遥测日志或在线历史 TLE 回放服务；当前真实模式使用固定公开快照，便于复现实验。
- 未实现 SDP4、J2/J4 显式摄动、姿态控制和高精度星历误差模型。
- 未模拟用户终端、接入业务和完整网络协议层转发。
- 未实现标准级 LDPC/BCH 译码、物理层帧结构、真实重传协议、闭环姿态控制、真实波束调度和完整频谱掩模。
- 未实现姿态控制、太阳翼指向角、热控、电池效率、复杂遮挡阴影和更细粒度真实功耗曲线等物理细节。

也就是说，当前项目是一个面向拓扑动态、链路连通性、链路预算、业务流量和可视化全网感知分析的 LEO 卫星网络仿真仪表盘，而不是完整的高保真轨道力学与网络协议栈仿真器。
## 真实运行模式与任务数据端口

仪表盘现在保留两套状态生成方式：

- `autonomous`：沿用原有自主生成的状态模拟，不需要外部输入，节点 CPU、队列、电量、温度等状态随时间片按内置波动模型生成。
- `operational`：真实运行模式。默认可以选择空业务、内置确定性业务场景或用户上传任务数据。没有业务输入时只计算轨道、链路、太阳光照、空载能耗和资源空闲状态，CPU/GPU、ISL 转发负载、链路业务利用率和业务队列保持为 0；选择业务场景或上传任务数据后，系统会把任务投放到当前 Walker 网络中，并按时间片计算每颗卫星的资源和能量状态。

网页端默认进入 `真实运行 + TLE + SGP4 + 正常业务`，与第一阶段验收、场景矩阵和命令行导出的默认研究口径一致。`自主模拟` 和 `解析 Walker` 仍可在顶部切换，用于演示或对照，但不作为第一阶段模型评估的默认入口。

仪表盘内置以下第一阶段业务场景，用于验证模型对不同负载的响应是否稳定、可解释：

| 场景 | 用途 |
| --- | --- |
| 空业务 | 验证 CPU/GPU/队列/ISL 转发负载保持空闲，电量只随光照和空载功耗变化 |
| 低负载 | 验证业务可路由且不过载 |
| 正常业务 | 默认业务模板，用于常规网络运行观察 |
| 高负载 | 验证链路容量、节点 CPU、通信功耗和队列随压力升高 |
| 热点业务 | 验证局部节点和局部链路出现压力集中 |
| 突发业务 | 验证短时间大流量导致队列、拥塞和丢弃 |
| 长时业务 | 验证持续业务跨多数时间片稳定运行 |

任务数据入口位于仪表盘顶部的数据集上传控件。当前支持 CSV 或 JSON。上传文件级契约见 `schemas/task-dataset-file.schema.json`，单条任务字段契约见 `schemas/task-dataset.schema.json`，样例说明见 `examples/datasets/README.md`。CSV 字段示例：

```csv
task_id,time,start_slice,duration_slices,source,target,node_id,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type
T-A,T00,0,4,P01-S01,P05-S08,,80,4,6,10,200,2,mixed
T-B,T02,2,3,,,P02-S03,120,2,4,5,0,1,compute
```

JSON 可以是数组，也可以是 `{ "tasks": [...] }`：

```json
[
  {
    "task_id": "T-A",
    "time": "T00",
    "start_slice": 0,
    "duration_slices": 4,
    "source": "P01-S01",
    "target": "P05-S08",
    "compute_units": 80,
    "gpu_units": 4,
    "memory_gb": 6,
    "storage_gb": 10,
    "traffic_mbps": 200,
    "priority": 2,
    "task_type": "mixed"
  }
]
```

标准字段包括 `time`、`source`、`target`、`traffic_mbps`、`compute_units`、`memory_gb`、`storage_gb`、`duration_slices`、`priority` 和 `task_type`。其中 `source` 与 `target` 同时存在时会触发最短路径路由；只有 `node_id` 时表示把任务资源直接投放到指定卫星。路由任务不能同时填写 `node_id`，本地任务不能填写 `source` 或 `target`；`traffic_mbps` 大于 0 的任务必须提供合法的 `source` 和 `target`。`priority` 数值越大，在多条业务争用同一条拥塞链路时越优先获得可承载容量；路径选择仍然采用当前配置的最短路径算法。`task_type` 会保留到每个时间片的路由记录中，其中 `telemetry` 会按实际承载业务量给源卫星增加遥测采样压力，`downlink` 会按实际承载业务量给目的卫星增加回传/缓存压力，比例由 `trafficModel.telemetryTaskSamplingRatio` 和 `trafficModel.downlinkTaskSamplingRatio` 控制。

解析器为了兼容外部数据集，也接受少量常见别名，例如 `duration` 可归一化为 `duration_slices`，`src`/`dst` 可归一化为 `source`/`target`，`cpu`/`compute` 可归一化为 `compute_units`，`traffic`/`bandwidth_mbps` 可归一化为 `traffic_mbps`。这些别名归一化已经纳入 `npm run audit:stage1` 和冻结清单检查；正式模板、冻结清单和论文实验建议始终使用标准字段，避免不同数据源之间含义不清。

仓库内置了一个可直接上传或命令行运行的标准样例：

```text
examples/datasets/stage1-standard-traffic.csv
examples/datasets/stage1-standard-traffic.json
```

这两个文件表达同一组标准业务，包含跨星路由、本地计算、遥测/下行业务、突发业务和持续业务；CSV 已经被 `npm run audit:stage1` 纳入第一阶段自动验收，CSV 与 JSON 都会被 `npm run verify:stage1` 纳入总体验证。

第一阶段审计还会额外比较这两个标准样例的仿真输出：CSV 和 JSON 解析后的任务数、关键指标和完整真值指纹必须一致。这样可以证明两种上传格式只是文件表达不同，不会改变卫星网络响应。

上传到仪表盘或导出前，可以先使用独立校验命令检查数据集：

```bash
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.json
```

该命令会输出接受任务数、警告、错误、路由任务数、本地任务数、总流量、总计算量和归一化后的 `datasetFingerprint`。`Errors` 必须为 `0`，否则该数据集不应作为第一阶段实验输入；同一份业务输入在后续导出的 `metadata.dataset_fingerprint` 中应保持一致。

内置业务场景也可以导出为标准 CSV 模板：

```bash
npm run export:templates
```

模板会写入 `examples/datasets/templates`，包括 `empty`、`low-load`、`normal`、`high-load`、`hotspot`、`burst` 和 `long-duration`。这些文件可以直接上传到仪表盘，也可以作为用户自定义数据集的起点。

真实运行模式中的状态计算包括：

- `compute_units` 会转化为 CPU 工作负载和 CPU 利用率增量。
- `gpu_units` 会转化为 GPU 利用率增量。
- `memory_gb`、`storage_gb` 会作为任务基础占用；队列和遥测缓存会继续形成总内存/存储占用。
- `traffic_mbps` 会进入最短路径路由，形成链路需求、承载流量、链路利用率、队列、拥塞和节点 ISL 转发负载；真实运行模式下链路利用率由当前时间片业务和链路容量计算，不再来自演示波动。
- 当多条任务同时经过同一条拥塞链路时，链路总容量先按 `priority` 从高到低服务新业务；未被承载的部分进入链路/节点队列，超过缓存能力后形成丢弃。导出的路由和任务追踪表会记录每条任务的 `carried_traffic_mbps`、`queued_traffic_mb` 和 `dropped_traffic_mb`。
- 真实运行模式下，最短路径路由只会使用当前可承接业务的卫星节点；处于节能或不可接收任务状态的节点不会作为源、目的或中继参与业务路由。物理链路仍会按拓扑和链路预算展示，业务可用性由路由状态单独体现。
- CPU、GPU 和通信功耗会共同带来温度上升。
- 活跃 ISL/SGL 链路会形成端口占用，链路实际承载流量会形成端点业务 CPU、转发 CPU 和通信附加功耗：

```text
CPU_endpoint = (ingress_traffic_Gbps + egress_traffic_Gbps) * endpointCpuPercentPerGbps
CPU_forward = carried_ISL_Gbps * forwardingCpuPercentPerGbps
CPU_queue = queue_GB * queueCpuPercentPerGb
CPU_total = CPU_compute + CPU_endpoint + CPU_forward + CPU_queue

Queue_next = Queue_prev * queueCarryoverRatio + Queue_new

Memory_used = task_memory
            + queue_GB * queueMemoryGbPerQueuedGb
            + telemetry_buffer_GB * telemetryMemoryGbPerBufferedGb

Storage_used = task_storage
             + cache_GB * cacheStorageGbPerBufferedGb

P_comm_extra = N_ISL * P_ISL,active + N_SGL * P_SGL,active
             + (carried_ISL_Gbps + downlink_Gbps) * forwardingPowerWPerGbps
             + queue_GB * queuePowerWPerGb

P_network_compute = (CPU_endpoint + CPU_forward + CPU_queue) / 100 * P_compute

P_load = P_base + P_comm + P_compute + P_payload
       + P_task_compute + P_network_compute + P_comm_extra

T_node = T_base + CPU_percent * k_cpu
       + GPU_percent * k_gpu
       + P_comm_extra * k_comm
```

- 遥测生成量会随节点 CPU、转发流量和链路拥塞增加：

```text
T_gen = T_base + CPU_percent * telemetryCpuMbPerPercent
      + carried_ISL_Gbps * k_traffic
      + max_congestion_percent * k_congestion
      + task_type_extra_mb
```

这些关系只刻画网络级占用、功耗和遥测压力，不模拟 MAC 退避、逐包重传或真实协议栈。
- 星地遥测下传会单独记入 `downlink_load_mbps`，不会混入业务 `forwarding_load_mbps`；因此空业务下 ISL 转发负载保持为 `0`，但仍可能存在基础遥测下传。
- 电池能量按带效率的 SoC 模型更新：`SoC(t)=E(t)/Ebat,max`。
- 每个时间片使用 `E(t + Δt)=clip[E(t)+ηch×max(Pgen-Pload,0)×Δt-max(Pload-Pgen,0)/ηdis×Δt, Emin, Ebat,max]`。
- 默认太阳翼面积 `2.0 m²`、效率 `0.28`、电池容量 `1200 Wh`，太阳翼峰值发电约 `762 W`。
- 默认充电效率 `ηch=0.95`，放电效率 `ηdis=0.95`。
- 默认整星负载由基础、通信、计算和载荷功耗组成，合计约 `330 W`。
- 卫星处于光照面时，按太阳翼输出与负载功耗的净值充电或放电；处于阴影面时，太阳翼输出为 `0`，电池按负载功耗下降。
- 电量不会降为 `0`，当前最低 SoC 为 `20%`；低于或等于该阈值时卫星进入节能模式，不继续承接作业，也不会参与业务路由，后续恢复到阈值以上后再恢复 `can_accept_tasks`。

第一阶段模型验收可以运行：

```bash
npm run verify:stage1
npm run audit:stage1
npm run audit:exports
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv
npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.json
npm run export:templates
npm run report:stage1
npm run assess:stage1
npm run baseline:stage1
npm run matrix:stage1
npm run trace:stage1
npm run freeze:stage1
```

`npm run verify:stage1` 是推荐的第一阶段总验证入口，会顺序运行生产构建、场景模板导出、仪表盘浏览器审计、标准 CSV/JSON 上传数据集校验、第一阶段成熟度评估、标准业务响应追踪导出、第一阶段可复现实验冻结清单和真值导出审计，并生成：

- `reports/stage1/stage1-verification.json`
- `reports/stage1/stage1-verification.md`
- `reports/stage1/stage1-dashboard-audit.json`
- `reports/stage1/stage1-dashboard-audit.md`
- `reports/stage1/stage1-business-trace.json`
- `reports/stage1/stage1-business-task-trace.csv`
- `reports/stage1/stage1-business-link-impact.csv`
- `reports/stage1/stage1-business-node-impact.csv`
- `reports/stage1/stage1-freeze-manifest.json`
- `reports/stage1/stage1-freeze-manifest.md`

该脚本会依次运行空业务、低负载、正常业务、高负载、热点、突发和长时业务，并额外解析 `examples/datasets/stage1-standard-traffic.csv` 与 `examples/datasets/stage1-standard-traffic.json` 作为上传数据集验收样例，同时用一个别名字段数据集检查外部字段名能否归一化为标准任务字段。它会检查空业务空闲、低负载不过载、高负载加压、内存/存储/温度/负载功率随压力响应、节点资源字段与配置公式逐片一致、链路需求/承载/队列/丢弃/拥塞字段与配置公式逐片一致、路由路径/跳数/距离/时延与当前活跃拓扑下的最短路径公式一致、拥塞链路上的高优先级业务获得更多承载、Walker 轨道面分布、TLE 元数据、轨道高度/速度范围和极区轨间断链约束一致、节能节点不参与业务路由、热点集中、突发排队、长时持续、上传数据集驱动路由和节点状态、拓扑物理仍生效和相同输入确定性。

此外，`audit:stage1` 会做四类第一阶段不变量检查：空业务下不得出现任务路由、任务占用、CPU/GPU 负载、业务流量、业务队列、链路业务需求或链路业务利用率；上传数据集下会检查本地计算任务落到指定卫星、跨星路由任务的路径链路真实存在并承载流量、源/目的/中继节点业务字段与路径一致、内存和存储占用覆盖任务需求；业务因果链审计会逐时间片复算“任务激活 -> 路由记录 -> 链路需求 -> 节点入/出/中继流量 -> 转发负载/队列/遥测缓存”的映射，并额外检查 `telemetry`/`downlink` 业务类型是否按实际承载量改变遥测生成量，确保业务输入真的驱动节点和链路真值状态；动态路由下会检查所有任务只使用当前时间片的活跃链路，存在极区或链路预算等约束断链时业务仍可路由，并且持续任务会随时间片拓扑变化产生不同路径。确定性检查会比较两次运行的完整真值指纹，覆盖节点状态、节点资源、链路状态、链路预算摘要、路由路径和路由状态，而不是只比较汇总指标。

`npm run report:stage1` 会在 `reports/stage1` 下生成 `stage1-acceptance.json` 和 `stage1-acceptance.md`，把上述 7 条第一阶段合格标准、关键指标和自动检查结果汇总成报告。临时生成报告时也可以直接运行：

```bash
node scripts/auditStageOne.mjs --report-dir .tmp/stage1-report
```

`npm run assess:stage1` 会先重新运行第一阶段验收，再生成：

- `reports/stage1/stage1-model-assessment.json`
- `reports/stage1/stage1-model-assessment.md`
- `reports/stage1/stage1-parameter-baseline.json`
- `reports/stage1/stage1-parameter-baseline.md`
- `reports/stage1/stage1-scenario-matrix.json`
- `reports/stage1/stage1-scenario-matrix.csv`
- `reports/stage1/stage1-scenario-matrix.md`
- `reports/stage1/stage1-business-trace.json`
- `reports/stage1/stage1-business-task-trace.csv`
- `reports/stage1/stage1-business-link-impact.csv`
- `reports/stage1/stage1-business-node-impact.csv`

该评估报告面向当前研究目标：第一阶段先建立高可信仿真底座，允许仪表盘直接读取全网真值；第二阶段再设计 INT 遥测机制，用 INT 采集结果去对照第一阶段真值。评估维度包括 Walker/TLE-SGP4 拓扑动力学、链路预算与拥塞、业务数据集耦合、节点资源/电池/遥测缓存响应、确定性、真值层、标准业务响应追踪和数据集接口。

`npm run baseline:stage1` 可单独刷新参数基线报告。该报告会固化星座规模、时间片、轨道约束、极区/遮挡/距离断链阈值、节点资源容量、电池和太阳翼参数、业务/队列参数、天线、链路预算、干扰、多普勒、噪声、天气和地面站参数，并给出当前 `config_fingerprint`。后续进行论文实验或第二阶段 INT 对照时，应把结果对应到同一个参数基线。

`npm run matrix:stage1` 可单独刷新场景矩阵报告。该报告会把空业务、低负载、正常业务、高负载、热点、突发、长时业务和标准上传数据集放到同一张表里，比较任务数、输入流量、路由样本、最大 CPU、最大转发负载、最大链路需求、拥塞、队列、功耗、遥测缓存和真值指纹。场景矩阵还会自动检查空业务严格空闲、低负载可路由且不过载、正常业务强于低负载、高负载强于正常业务、热点/突发形成队列或拥塞、长时业务覆盖全部时间片、上传数据集确实驱动路由和节点/链路状态变化，用来证明业务输入和网络状态之间存在稳定、可解释的响应关系。

`npm run trace:stage1` 可单独刷新标准业务响应追踪。它默认读取 `examples/datasets/stage1-standard-traffic.csv`，生成：

- `stage1-business-trace.json`：追踪元数据、指纹、行数、状态分布、自检结果，以及 `telemetry/downlink` 业务类型产生的额外遥测真值总量。
- `stage1-business-task-trace.csv`：以任务和时间片为主线，记录路由状态、路径、瓶颈链路、最大链路利用率、路径节点 CPU/转发负载/遥测缓存、约束断链上下文，并导出该任务本时间片的 `task_telemetry_generated_mb`。
- `stage1-business-link-impact.csv`：记录每条任务路径经过的链路，以及该链路当时的需求、承载、容量、利用率、拥塞、队列、丢弃、SINR、容量预算和任务类型。
- `stage1-business-node-impact.csv`：记录每条任务路径涉及的源节点、中继节点、目的节点或本地计算节点，以及这些节点当时的 CPU 分量、入/出/中继流量、缓存、遥测、电量、功耗、温度和任务类型造成的遥测增量。

这些追踪文件用于回答“某条业务在某个时间片为什么造成了这些节点/链路状态变化”，比全量快照更适合做第一阶段模型解释和第二阶段 INT 观测对照。

`npm run freeze:stage1` 会生成第一阶段可复现实验冻结清单。它不会替代源码版本管理，而是把当前仿真底座的关键证据集中到：

- `stage1-freeze-manifest.json`
- `stage1-freeze-manifest.md`

清单会检查第一阶段验收、成熟度评估、场景矩阵、标准业务追踪、配置指纹、标准上传数据集指纹、标准上传真值指纹、schema、关键报告和复现命令是否一致。进入第二阶段 INT 遥测设计前，建议把这份清单和 `config_fingerprint`、`dataset_fingerprint`、`truth_fingerprint` 一起记录为实验基线。

仪表盘顶部提供 `导出真值` 控件，可下载：

- `完整 JSON`：包含 metadata、每个时间片的完整 `NetworkSlice` 和网络指标，适合作为第一阶段仿真真值留档。
- `节点 CSV`：每个时间片每颗卫星一行，包含轨道位置、速度、资源、电量、温度、业务、缓存和遥测状态，并导出 `compute_cpu_percent`、`task_traffic_cpu_percent`、`forwarding_cpu_percent`、`queue_cpu_percent`、`task_compute_power_w`、`network_compute_power_w` 等公式贡献分量。
- `链路 CSV`：每个时间片每条候选链路一行，包含连通状态、断链原因、链路预算、SINR、容量、拥塞和误包率。
- `路由 CSV`：每个时间片每条任务路由一行，包含路径、链路序列、跳数、时延、优先级、承载流量、排队量、丢弃量、任务类型遥测贡献和可达状态。
- `指标 CSV`：每个时间片一行，汇总全网可用率、任务、队列、转发、下传、遥测和最大拥塞。
- `任务追踪 CSV`：按任务和时间片记录路由状态、路径、瓶颈链路、路径节点最大 CPU/转发负载/遥测缓存和约束断链上下文。
- `链路影响 CSV`：按任务路径经过的链路记录需求、承载、容量、利用率、拥塞、队列、丢弃、SINR 和容量预算。
- `节点影响 CSV`：按任务涉及的源/中继/目的/本地节点记录 CPU 分量、入/出/中继流量、缓存、遥测、电量、功耗和温度。

完整 JSON 和命令行导出的 `metadata.json` 会包含 `export_schema_version`、`config_fingerprint`、`dataset_fingerprint` 和 `truth_fingerprint`。其中 `config_fingerprint` 标识本次仿真参数基线，`dataset_fingerprint` 标识业务输入，`truth_fingerprint` 标识完整时间片真值输出。第二阶段做 INT 遥测对照时，应把观测结果绑定到同一个 `truth_fingerprint`，避免不同配置或不同业务数据集之间误比较。

内置业务场景也会被视为正式业务输入写入 metadata。例如 `normal` 场景会记录生成的任务数、总流量、总计算量、内存和存储需求；上传数据集则记录用户文件中的任务摘要。这样内置模板和外部数据集在复现实验中使用同一套输入标识口径。

仪表盘正文还提供 `第一阶段真值概览` 面板，按当前生成的全部时间片汇总时间片/节点/链路规模、路由样本、业务任务数、动态换路任务、不可用链路误用、约束断链样本、电池能量范围、最大 CPU/转发负载、最大链路拥塞和遥测生成/下传量。该面板也会直接展示当前 `config_fingerprint`、`dataset_fingerprint` 和 `truth_fingerprint`，用于在网页端确认当前画面对应哪一个可复现实验基线。

`任务路由` 表会按当前时间片列出每条任务的路由状态、优先级、需求/承载流量、排队/丢弃量、跳数、时延和路径。这样在发生拥塞或优先级调度时，可以直接从仪表盘看到业务输入如何转化为链路承载结果和节点状态变化。

`npm run audit:exports` 会检查这些导出表的行数、表头和 JSON 元数据是否完整。完整 JSON 会比较大，日常数据分析优先使用 CSV。

也可以在命令行直接生成第一阶段实验真值：

```bash
npm run export:scenario -- --profile normal --orbit tle-sgp4 --out exports/normal-tle
```

该命令会输出 `metadata.json`、`nodes.csv`、`links.csv`、`routes.csv` 和 `metrics.csv`。需要完整时间片真值时追加 `--full-json`；需要使用外部业务数据集时传入 `--tasks data/tasks.csv` 或 `--tasks data/tasks.json`。命令行导出和仪表盘下载使用同一套导出函数，可作为后续 INT 遥测实验的全知真值对照。

轨道状态中也加入了相对地面的东西向移动：

- 系统先计算卫星 ECI 坐标。
- 再根据地球自转角速度转换为 ECEF 坐标。
- 由 ECEF 坐标得到星下点经纬度。
- `eastWestDriftDeg` 表示卫星相对地面经度方向的漂移量。
