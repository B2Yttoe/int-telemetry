# 实验 6：采样率敏感性实验

## 实验做了什么

本实验在 5%、10%、15%、20%、25%、30%、40% 七档采样率下，对增强前 INT-MC 和完整增强 LEO-INT-MC 进行三规模、48时间片扫描。每个采样率独立生成pass-1 OAM，禁止跨采样率复用反馈。详细曲线见 [实验6 HTML报告](reports/experiment6-sampling-sensitivity/experiment6-sampling-report.html)。

## 实验结果

以下膝点是在各方法、各星座内部，将开销和CPU/队列/电量/链路利用率误差归一化后，到理想点距离最小的Pareto点：

| 星座 | 方法 | 推荐折中采样率 | B/节点/片 | CPU MAE | 电量 MAE | 利用率 MAE |
|---|---|---:|---:|---:|---:|---:|
| Iridium 66 | 增强前 INT-MC | 0.2 | 473.6364 | 0.4245 | 0.9770 | 2.2598 |
| Iridium 66 | 完整增强 LEO-INT-MC | 0.4 | 426.4316 | 0.2359 | 0.1261 | 1.0931 |
| Telesat 351 | 增强前 INT-MC | 0.15 | 349.5043 | 2.5438 | 1.8422 | 0.5372 |
| Telesat 351 | 完整增强 LEO-INT-MC | 0.15 | 306.8494 | 1.1959 | 0.4331 | 0.4977 |
| Starlink 1584 | 增强前 INT-MC | 0.1 | 18.6995 | 1.8723 | 6.3647 | 2.4329 |
| Starlink 1584 | 完整增强 LEO-INT-MC | 0.1 | 24.7435 | 0.9667 | 2.0567 | 1.8636 |

## 证明了什么

实验展示算法优势是否只在25%单点成立，并给出降低采样率时误差、覆盖和逐片波动的变化。Pareto前沿说明哪些采样率在开销和误差上不被其他点同时支配。

## 不能证明什么

膝点是当前指标归一化下的描述性折中，不是所有业务和星座的唯一最优采样率；公开仿真结果不能替代真实运营网络在线调参。

## 产物索引

- [HTML 可视化](reports/experiment6-sampling-sensitivity/experiment6-sampling-report.html)
- [汇总 CSV](reports/experiment6-sampling-sensitivity/experiment6-sampling-summary.csv)
- [汇总 JSON](reports/experiment6-sampling-sensitivity/experiment6-sampling-summary.json)
- [实验 manifest](reports/experiment6-sampling-sensitivity/experiment6-manifest.json)

## 复现

`npm run experiment6:sampling`
