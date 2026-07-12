# 实验 11：动态等预算机制消融

- 星座规模：3
- 动态压力：0、0.25
- 配对种子：10
- 机制配置：6
- 公平性门禁：60/60
- 稳定正贡献：29
- 稳定负贡献：37
- 统计不确定：234

本实验在完全相同的实际遥测字节上限下，对完整增强版 LEO-INT-MC 的五类机制组进行逐组移除。正贡献表示移除机制后结果变差，即该机制对完整方案有实质帮助。动态性交互效应为 25% 与 0% 压力下贡献之差。

## 严格等预算

所有变体均采用发送前硬预算准入，并用无信息 padding 对齐实际网络负载。padding 计入网络字节和能耗，不携带 metadata，也不产生覆盖收益。

## 结果边界

报告保留 37 项稳定负贡献和 234 项统计不确定结果。本实验用于识别增强机制的因果贡献，不能替代真实运营网络或独立包级仿真验证。

## 产物

- 可视化报告：E:\INT-Temerity\reports\experiment11-dynamic-equal-budget-ablation\experiment11-dynamic-ablation-report.html
- 逐种子结果：E:\INT-Temerity\reports\experiment11-dynamic-equal-budget-ablation\experiment11-ablation-by-seed.csv
- 机制贡献：E:\INT-Temerity\reports\experiment11-dynamic-equal-budget-ablation\experiment11-mechanism-contributions.csv
- 动态性交互：E:\INT-Temerity\reports\experiment11-dynamic-equal-budget-ablation\experiment11-dynamicity-interactions.csv
- 公平性审计：E:\INT-Temerity\reports\experiment11-dynamic-equal-budget-ablation\experiment11-budget-fairness.csv
