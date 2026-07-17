# 实验 2-11 正式结果索引

更新时间：2026-07-12

本文档给出当前可用于论文、答辩和实验复现的正式结果入口。`reports/` 顶层只保留最新正式结果及其必要共享输入；开发期 smoke、pilot、临时核查和被替代的历史版本已移入归档目录。

## 正式结果

| 实验 | 研究问题 | 正式结果目录 | 主要报告 |
|---|---|---|---|
| 实验 2 | 原生 INT 基线、原生 INT-MC 与无真值泄漏 LEO-INT-MC 的覆盖率、开销和重构误差对比 | `reports/experiment2-int-mc-oracle-free-replay`、`reports/experiment2-baseline-comparison-oracle-free-replay` | `experiment2-int-mc-enhancement-comparison.html`、`experiment2-comprehensive-baseline-report.html` |
| 实验 2 共享输入 | 为实验 2 以及实验 4-7 提供 48 时间片三种星座真值和原生基线 | `reports/experiment2-native-baseline-rerun-final` | `experiment2-constellation-comparison-report.html` |
| 实验 3 | 在相同 CPU 单指标观测掩码下比较低秩、ST-GNN 和 CoSTCo 补全 | `reports/experiment3-cpu-single-metric-completion` | `experiment3-cpu-completion-report.html` |
| 实验 4 | 消融拓扑适配、OAM 闭环、自适应开销、轨道先验和状态耦合 | `reports/experiment4-leo-int-mc-ablation` | `experiment4-ablation-report.html` |
| 实验 5 | 分解遥测字节、ISL 承载、能耗、规划与补全时间开销 | `reports/experiment5-overhead-decomposition` | `experiment5-overhead-report.html` |
| 实验 6 | 比较 5%-40% 采样率下的误差、开销、波动和 Pareto 折中 | `reports/experiment6-sampling-sensitivity` | `experiment6-sampling-report.html` |
| 实验 7 | 检验隐藏真值、未来反馈、观测值锁定和不可用链路掩码约束 | `reports/experiment7-no-truth-leakage` | `experiment7-report.html` |
| 实验 8 主实验 | 在固定参数下施加 0%-25% 拓扑扰动，比较原生与增强方法 | `reports/experiment8-dynamicity-causality` | `experiment8-dynamicity-report.html` |
| 实验 8 参考计划回放 | 证明不适配新拓扑的历史 probe plan 会产生真实路径失效 | `reports/experiment8-native-reference-replay` | `experiment8-native-static-report.html` |
| 实验 8 多种子 | 用 30 个随机种子检验动态扰动导致的额外路径失效是否稳定 | `reports/experiment8-multi-seed-robustness` | `experiment8-multi-seed-report.html` |
| 实验 8 回传中断 | 在固定 probe plan 和生成字节下检验星地 reporting path 中断影响 | `reports/experiment8-reporting-interruption-sensitivity` | `experiment8-reporting-sensitivity-report.html` |
| 实验 9 | 用两个独立 CelesTrak 历元、RIPE Atlas 和 Cloudflare Radar 检验公开可观测维度 | `reports/experiment9-multi-epoch-external-validation` | `experiment9-external-validation-report.html` |
| 实验 10 | 在相同实际遥测硬字节预算下，以三种规模、三档动态性和 10 个配对种子比较原生全重规划、增强 LEO-INT-MC 与参考计划回放 | `reports/experiment10-equal-budget-dynamic-multiseed` | `experiment10-equal-budget-report.html` |
| 实验 11 | 在相同第一阶段真值和严格相同实际字节预算下，以三种规模、0%/25% 动态压力和 10 个配对种子逐组移除五类 LEO 增强机制 | `reports/experiment11-dynamic-equal-budget-ablation` | `experiment11-dynamic-ablation-report.html` |

## 使用边界

1. 实验 8 的四个目录不是重复版本。它们分别承担主因果对比、静态计划失效、多种子统计和回传中断敏感性证据，论文中应联合引用。
2. `experiment2-native-baseline-rerun-final` 是实验 4-7 的共享输入，不能按目录名中的 `rerun` 误判为废弃版本。
3. CPU、电量和队列是仿真模型内部潜变量。它们可用于算法真值检验，但不能描述为 Starlink 运营商公开真值。
4. Cloudflare Radar 结果属于同源业务曲线校准，不是独立留出验证；实验 9 已在报告中显式标记这一边界。
5. 论文图表应从上述正式目录的 CSV/JSON 生成，不能从归档目录选取更有利的历史数值。
6. 实验 10 的主比较组使用不携带观测信息的 padding 对齐实际网络负载。padding 计入字节、转发和能耗，但不产生 metadata 或覆盖收益；参考计划回放不填充，以保留路径失效造成的预算利用不足。
7. 实验 10 的结论必须按规模解释：中大型星座的节点状态重构收益较稳定，小型星座与部分链路指标存在退化或不显著结果，不能概括为全规模全指标全面优于原生方法。
8. 实验 11 中正贡献表示移除机制后结果变差。规划与重构耗时应和状态质量分开阅读：移除机制更快通常表示该机制具有计算代价，不等同于状态重构退化。
9. 实验 11 的 60 个配对场景均通过等实际字节门禁，最大方法间差值为 0；无信息 padding 只用于控制网络负载，不产生观测覆盖或补全收益。

## 历史归档

旧版结果位于：

`reports/_archive/experiments2-9-pre-final-20260711`

归档包含 20 个目录、1303 个文件，合计 1,181,783,941 字节。归档只用于追溯开发过程，不作为当前论文结论来源。

实验 10 的 smoke、预算校准和 pilot 位于：

`reports/_archive/experiment10-development-20260711`

实验 11 的 smoke 与开发核查位于：

`reports/_archive/experiment11-development-20260712`
