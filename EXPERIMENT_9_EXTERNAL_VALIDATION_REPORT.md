# 实验 9：多历元公开数据外部验证

## 证据状态

- 状态：complete
- 独立验证历元：2
- 输入/验证独立性：通过
- 卫星-历元配对：3168
- SGP4 传播失败：0

## CelesTrak 轨道证据

本实验使用 2 个独立验证历元。

| 验证历元 | 比较时刻 | 平均历元间隔 h | 匹配卫星 | ECI MAE km | 径向 MAE | 沿轨 MAE | 横轨 MAE |
|---|---|---:|---:|---:|---:|---:|---:|
| validation-1 | 2026-07-06T11:18:26.526Z | 85.243 | 1584 | 83.606 | 7.499 | 80.946 | 0.517 |
| validation-2 | 2026-07-10T07:41:45.953Z | 180.715 | 1584 | 264.569 | 20.465 | 259.321 | 1.082 |

综合平均历元间隔为 132.978821 h，ECI 位置 MAE 为 174.087416 km。误差包含 TLE/SGP4 跨历元预测误差和 CelesTrak 后续目录更新差异，不是精密定轨误差。

## Cloudflare Radar 业务证据

- 证据类型：校准拟合（不是独立留出验证）
- 外部数值点：168
- 归一化曲线相关系数：0.9134

当前 0.9134 一类相关系数来自与业务生成相同的 Radar 数据和重叠时间窗，因此属于校准拟合，不是独立留出验证。它不能解释成真实逐卫星流量 trace。

## RIPE Atlas 网络证据

- 公开 ping 样本：958
- 模型用户侧 P50 RTT：23.6491 ms
- 公开 P50 RTT：28.8553 ms

## 内部潜变量边界

CPU、电量和队列是模型公式生成的内部潜变量，只能通过物理一致性、守恒关系和业务响应合理性进行验证，不能被描述为 Starlink 或其他运营商内部真值。

因此，本实验支持“公开可观测轨道和网络性能维度具有外部证据”的结论，但不能证明所有星上内部状态逐点等于运营商内部真值。

## 产物

- [HTML 报告](reports/experiment9-multi-epoch-external-validation/experiment9-external-validation-report.html)
- [历元注册表](reports/experiment9-multi-epoch-external-validation/external-epoch-registry.csv)
- [逐历元汇总](reports/experiment9-multi-epoch-external-validation/orbit-validation-per-epoch.csv)
- [轨道逐星对照](reports/experiment9-multi-epoch-external-validation/orbit-cross-epoch-comparison.csv)
