# 实验 9：多历元公开数据外部验证

## 证据状态

- 状态：complete
- 历元记录：3
- 输入/检验独立性：通过

## CelesTrak 轨道证据

- 匹配卫星：1584
- ECI 位置 MAE：112.174522 km
- 径向 MAE：11.239156 km
- 沿轨 MAE：106.730695 km
- 横轨 MAE：0.534186 km

以上误差同时包含 TLE/SGP4 跨历元传播误差和 CelesTrak 后续目录更新，不是精密定轨误差。

## Cloudflare Radar 业务证据

- 外部数值点：168
- 归一化曲线相关系数：0.9134

Radar 只用于聚合业务时序形状校准，不能解释成真实逐卫星流量 trace。

## RIPE Atlas 网络证据

- 公开 ping 样本：958
- 模型用户侧 P50 RTT：23.6491 ms
- 公开 P50 RTT：28.8553 ms

## 内部潜变量边界

CPU、电量和队列是模型公式生成的内部潜变量，只能通过物理一致性、守恒关系和业务响应合理性进行验证。它们不能被描述为 Starlink 或其他运营商内部真值。

因此，本实验能支持“公开可观测维度与真实数据一致或量级相符”的结论，不能证明所有星上内部状态逐点等于运营商内部真值。

## 产物

- [HTML 报告](reports/experiment9-multi-epoch-external-validation/experiment9-external-validation-report.html)
- [历元注册表](reports/experiment9-multi-epoch-external-validation/external-epoch-registry.csv)
- [轨道逐星对照](reports/experiment9-multi-epoch-external-validation/orbit-cross-epoch-comparison.csv)
