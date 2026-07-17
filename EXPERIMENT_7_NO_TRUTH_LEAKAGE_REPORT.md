# 实验 7：无真值泄漏合法性验证实验

## 实验做了什么

本实验不比较重构误差大小，而是检查实验 2、4-6 使用的增强 LEO-INT-MC 是否遵守可部署遥测边界。它对三种规模分别执行八项检查，并用反事实数据重新运行路径选择器。详细证据见 [实验7 HTML报告](reports/experiment7-no-truth-leakage/experiment7-report.html)。

## 实验结果

共执行 24 项检查，通过 24 项；生成 9 条规划哈希证据。

| 星座/夹具 | 通过检查 | 结论 |
|---|---:|---|
| Iridium 66 | 8/8 | 通过 |
| Telesat 351 | 8/8 | 通过 |
| Starlink 1584 | 8/8 | 通过 |

## 无真值数值泄漏

在保持拓扑标识、轨道接触预测、业务请求和 OAM 输入不变的情况下，大幅改写隐藏 CPU、队列、电量、链路利用率和状态。若选出的 probe plan 哈希保持一致，说明路径选择不依赖这些未观测真值。非法的 truth-error、simulation-validation 和 completion-error 反馈必须被拒绝。

## 时间因果合法

Ground OAM 和补全置信度反馈至少滞后一片进入规划。实验注入来源时间片不早于截止点的未来反馈，并要求截止点之前的 probe plan 不发生变化；同时审计所有规划状态来源满足 source_slice < target_slice。

## 真值仅用于事后评估

第一阶段真值允许用于轨道/链路可用性预测和实验结束后的 MAE、RMSE、准确率计算，但不得直接进入动态状态评分、复测目标生成和当前时间片路径选择。报告分别核验 manifest、路径选择器边界字段、补全评估边界和源码数据流入口。

## 证明了什么

本实验能证明当前实现满足所声明的 OAM-only、单时间片因果滞后和事后真值评估边界；观察值锁定与不可用链路锁定也防止矩阵补全覆盖直接测量或创造不存在的链路。

## 不能证明什么

通过合法性审计不等于真实硬件部署已经安全，也不证明观测噪声、时钟误差或攻击条件下仍然成立。反事实检查覆盖当前代码路径与正式配置，后续修改路径选择器或反馈格式后必须重新运行。

## 产物索引

- [HTML 可视化](reports/experiment7-no-truth-leakage/experiment7-report.html)
- [检查 CSV](reports/experiment7-no-truth-leakage/experiment7-checks.csv)
- [汇总 JSON](reports/experiment7-no-truth-leakage/experiment7-summary.json)
- [实验 manifest](reports/experiment7-no-truth-leakage/experiment7-manifest.json)

## 复现

`npm run experiment7:legality`
