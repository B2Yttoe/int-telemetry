# 实验 10：严格等硬字节预算动态多种子实验

- 正式种子数：10
- 方法行：270
- 公平场景：90/90
- 相对原生全重规划的稳定正向结果：29
- 稳定负向结果：13
- 置信区间跨 0：21

本实验在相同实际遥测硬上限下比较原生每片全重规划、增强 LEO-INT-MC 和原生参考计划回放。正的配对改进表示增强方法优于对应对照；所有负结果均保留。

## 主要结论

- Iridium 66：稳定改善 3 项，稳定退化 12 项，不确定 6 项。
- Starlink 1584：稳定改善 11 项，稳定退化 1 项，不确定 9 项。
- Telesat 351：稳定改善 15 项，稳定退化 0 项，不确定 6 项。

结论应按规模解释：中大型星座上的节点状态和规划收益构成主证据；小型星座以及链路指标的退化或不显著结果构成适用边界。padding 只用于对齐网络负载，不携带 metadata，也不计为有效覆盖收益。

## 产物

- HTML：E:\INT-Telemetry\reports\experiment10-equal-budget-dynamic-multiseed\experiment10-equal-budget-report.html
- 原始逐种子 CSV：E:\INT-Telemetry\reports\experiment10-equal-budget-dynamic-multiseed\experiment10-equal-budget-by-seed.csv
- 聚合 CSV：E:\INT-Telemetry\reports\experiment10-equal-budget-dynamic-multiseed\experiment10-equal-budget-aggregate.csv
- 配对效应 CSV：E:\INT-Telemetry\reports\experiment10-equal-budget-dynamic-multiseed\experiment10-paired-effects.csv
- 公平性 CSV：E:\INT-Telemetry\reports\experiment10-equal-budget-dynamic-multiseed\experiment10-budget-fairness.csv
