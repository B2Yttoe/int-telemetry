# 三档卫星网络模型说明

本文档说明当前项目用于后续实验的“小 / 中 / 大”三档卫星网络模型。三档模型服务于不同实验目的：小型模型强调真实 crosslinked 星座基线，中型模型强调传统 LEO 网络仿真方案与算法可扩展性，大型模型强调真实 Starlink-like 大规模拓扑。

## 当前正式模型

| 规模 | 仪表盘名称 | 节点数 | 轨道面 x 槽位 | 快照文件 | 适用实验 |
|---|---|---:|---:|---|---|
| 小型 | Iridium NEXT 6x11 | 66 | 6 x 11 | `data/tle-snapshots/celestrak-iridium-next-real-walker-6x11.json` | 小规模 INT、低开销采样、极区与 seam 约束敏感性实验 |
| 中型 | Telesat-1015 27x13 | 351 | 27 x 13 | `data/tle-snapshots/synthetic-telesat-1015-hypatia-walker-27x13.json` | 中规模原生 INT、INT-MC / CoSTCo 补全、覆盖率-开销和传统仿真方案对照实验 |
| 大型 | Starlink 主实验 72x22 | 1584 | 72 x 22 | `data/tle-snapshots/celestrak-starlink-real-walker-72x22.json` | 正式大规模 Starlink-like INT/INT-MC/CoSTCo 实验 |

## 为什么这样选择

小型模型采用 **Iridium NEXT**。它是真实存在的 crosslinked Walker-Star 网络，公开资料中明确为 6 个近极轨道面、每面 11 颗运行卫星、合计 66 颗。它适合做小规模星间链路遥测、极区断链、seam 区域和四向 ISL 约束实验。

中型模型采用 **Telesat / Hypatia Telesat-1015**。Hypatia 是 LEO 卫星网络仿真领域常用框架，Telesat-1015 设计参数常用于研究仿真：27 个轨道面、每面 13 颗、合计 351 颗，约 1015 km 高度、98.98° 倾角。该模型不是当前运营商当天真实 TLE 快照，而是传统研究仿真方案中的公开设计参数模型；它的价值在于规模适中、拓扑规则、具备 ISL，适合 INT-MC、CoSTCo、采样率、覆盖率-开销和矩阵补全等算法实验。

大型模型采用 **Starlink 72x22**。这是后续主实验模型，参考公开 Starlink 主壳层建模口径，并以 CelesTrak STARLINK GP/TLE 快照生成 1584 颗星的真实轨道传播场景。它适合作为本文最终的大规模 LEO 网络真值底座。

`data/tle-snapshots/synthetic-starlink-polar-shell-97deg-walker-6x58.json` 可以保留为 Starlink 极轨壳层补充场景，但不再作为正式三档模型之一。

## 代码入口

三档模型注册表：

```text
src/config/constellationProfiles.ts
```

仪表盘会从该注册表读取：

- 星座名称和规模标签；
- TLE / 合成 TLE 快照；
- Walker/TLE-SGP4 配置；
- 链路预算、天线、能耗和业务参数；
- 实验用途说明。

主仪表盘中可以直接切换“小型 / 中型 / 大型”模型。切换后，节点数、链路数、轨道面、真值导出和 INT 遥测仿真都会跟随当前模型变化。

## 验证命令

验证三档模型快照和最小拓扑生成：

```bash
npm run verify:constellations
```

当前通过的验证结果：

| 模型 | 节点/片 | 链路/片 | 首片活动链路 | 快照指纹 |
|---|---:|---:|---:|---|
| Iridium NEXT 6x11 | 66 | 121 | 87 | `75f53801` |
| Telesat-1015 27x13 | 351 | 689 | 667 | `f7dd9bbc` |
| Starlink 72x22 | 1584 | 2871 | 2737 | `eb0f9db4` |

构建前端：

```bash
npm run build
```

## 外部依据

- Iridium NEXT：公开资料说明 Iridium 网络由 6 个近极轨道面、每面 11 颗 crosslinked 卫星组成，共 66 颗运行卫星。
  https://investor.iridium.com/2018-07-25-Iridium-Completes-Seventh-Successful-Iridium-R-NEXT-Launch

- Hypatia：LEO 卫星网络仿真框架，支持预计算动态网络状态、ns-3 仿真和可视化；其测试/示例体系包含 Telesat-1015、Kuiper-630、Starlink-550 等研究仿真星座。
  https://github.com/snkas/hypatia

- Hypatia TLE 说明：公开资料中列出测试星座包括 `Telesat-1015: 27 orbits x 13 satellites, 98.98° inclination`。
  https://deepwiki.com/snkas/hypatia/3.1.2-satellite-orbits-%28tles%29

- Starlink 主壳层：公开星座资料常用 72 个轨道面、每面 22 颗、合计 1584 颗作为第一代主壳层建模口径。
  https://space.skyrocket.de/doc_sdat/starlink-v1-5.htm

- CelesTrak GP/TLE 数据接口：用于生成本项目真实轨道快照。
  https://celestrak.org/NORAD/elements/

## 论文表述边界

这些模型可以表述为：

> 基于公开 CelesTrak TLE/GP 快照、Hypatia 传统设计参数模型和可解释链路/节点状态公式构建的多规模 LEO 卫星网络仿真环境。

不应表述为：

> 三个星座全部都是运营商当天完整真实网络，或真实业务流、真实星上 CPU/队列/路由状态的逐点复刻。

后续 INT/INT-MC 实验中，第一阶段模型继续作为全知真值底座；第二阶段遥测算法只能通过探测结果重构该真值。
