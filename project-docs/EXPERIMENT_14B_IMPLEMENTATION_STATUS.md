# 实验 14B 实施与证据状态

更新时间：2026-07-16（UTC 校正 v2 冻结后、GP0 获取前）

权威实验目录：

```text
reports/experiment14b-prospective-external-validation-v2-utc-corrected/
```

本文中的“完成”分为三种，不可混用：

- **实现完成**：代码、配置和自动化入口已经存在；
- **验收完成**：测试、冻结哈希或独立结果已经证明实现按预期工作；
- **外部结论完成**：冻结后未来数据已经到达并通过预注册门禁。

## 1. 最新 GP/OMM 与轨道年龄门禁

| 项目 | 当前状态 | 权威证据 |
|---|---|---|
| standard GP 与 supplemental GP 自动获取 | 实现并冻结 | `scripts/experiments/freshOrbitAcquisition.mjs`、v2 `freeze-manifest.json` |
| 内容更新门禁 | 实现并冻结 | GP0 必须晚于 `gp0_not_before`，且源 SHA-256 不得等于冻结基线 |
| 72x22 壳层年龄门禁 | 实现并测试 | 中位年龄不超过 24 h、P95 不超过 48 h、未来历元比例不超过 2% |
| 无时区 OMM 历元统一按 UTC | 已修正并测试 | `scripts/testOrbitUtcEpoch.mjs`，跨 `Asia/Shanghai`/`UTC` Walker 映射一致 |
| 正式 GP0 | 等待外部时间门禁 | 北京时间 2026-07-16 15:42:37 后自动获取 |
| 未来 GP1 盲测 | 未到时间 | GP0 后至少 24 h、同源族且内容更新后获取 |

旧 v2 已在未来结果进入前退役，记录为：

```text
reports/experiment14b-prospective-external-validation-v2/UTC_EPOCH_RETIREMENT.json
```

## 2. 同口径用户侧 RTT 与吞吐

| 项目 | 当前状态 | 权威证据 |
|---|---|---|
| 用户终端到服务器 RTT | 实现并测试 | 接入 SGL、星间/回退路径、网关、地面段和处理时延共同组成 |
| NDT7 下载吞吐口径 | 实现并测试 | SGL、网关、路径瓶颈和调度份额共同限制 |
| 测试目标不参与预测 | 已测试 | 修改测试行的外部 RTT/吞吐不会改变模型预测 |
| 同一时间、用户地域和服务器地域配对 | 实现并冻结 | strict-pairing 与 strict-scoring 两个附加冻结 |
| 正式未来评分 | 等待未来数据 | 只有通过严格配对的 M-Lab/RIPE 记录进入主分数 |

该层不再使用星座内部任务时延冒充用户 ping，也不把链路容量直接等同于 NDT7 用户吞吐。

## 3. Radar、RIPE 与 M-Lab 未来盲测

| 来源 | 当前状态 | 约束 |
|---|---|---|
| Cloudflare Radar | 采集器已冻结，未来结果待获取 | 只用冻结前 168 h 校准；冻结后 48 h 测试；测试值不得回调参数 |
| RIPE Atlas | 来源身份预检和冻结完成 | AS14593 固定探针到预注册 Dubai 固定 Anchor；至少 20 条严格记录 |
| M-Lab | 查询语义、来源审计和 BigQuery 采集器已冻结 | `unified_downloads`、`node._Instruments = 'ndt7'`、严格时间与地域配对 |

当前外部前置条件：

- Cloudflare Radar 尚未检测到 `CLOUDFLARE_API_TOKEN`；
- M-Lab 尚未检测到 Google OAuth/服务账号和查询项目；
- 缺少凭据时结果保持 `pending`，禁止使用旧值或合成值替代。

## 4. 严格配对与因果冻结

已完成并通过测试的结果前冻结包括：

1. 主协议与代码配置冻结；
2. 严格时间/地域/服务器配对冻结；
3. 严格评分冻结；
4. RIPE 固定 Anchor 来源冻结；
5. Radar 因果评分冻结；
6. M-Lab 来源、查询修正和 BigQuery 采集器冻结；
7. 完成性审计冻结。

GP0 与 M-Lab 查询锁生成后，`resumeExperiment14BV2FinalEvidenceFreeze.ps1` 会在任何 GP1、Radar、RIPE 或 M-Lab 未来结果进入前冻结总证据链。

## 5. ns-3 小规模逐包交叉验证

状态：**验收完成**。

- 66 个节点、20 个时间片；
- 9/9 核心组合和 3/3 压力组合完成；
- 覆盖 no-INT、full-INT 和选择性 LEO 遥测；
- 直接记录 INT 字节、MTU 超限、排队、丢包、报告交付率、报告 RTT 与 OAM AoI；
- `npm run experiment13:audit` 的桌面和移动报告均通过，无乱码且证据状态完整。

该实验只能证明选择性 metadata 与报告语义在逐包环境中可执行，并检验聚合模型趋势；它不等价于真实 Starlink 硬件或在轨部署。

## 6. CPU、电量与队列声明边界

状态：**声明边界已冻结**。

- CPU、电量和队列由任务、转发、遥测、光照、容量和守恒方程驱动；
- 可作为同一冻结仿真环境下比较 INT/OAM 算法的仿真真值；
- 只能声明物理约束一致性、输入响应和相对实验有效性；
- 不得声明为 Starlink 运营商逐星内部寄存器、真实电池或真实队列测量。

权威边界文件：

```text
project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md
```

## 7. 当前总判定

| 目标 | 实现 | 当前验收/外部结论 |
|---|---:|---|
| GP/OMM 自动获取与年龄门禁 | 完成 | 等待正式 GP0/GP1 |
| 同口径 RTT/吞吐层 | 完成 | 单元验收完成，未来盲测待完成 |
| 未来 Radar/RIPE/M-Lab | 完成采集链 | RIPE 等待窗口；Radar/M-Lab 还需要凭据 |
| 严格配对 | 完成 | 冻结与测试完成，实际样本待到达 |
| ns-3 逐包交叉验证 | 完成 | 12/12 组合完成 |
| 内部潜变量声明边界 | 完成 | 文档与最终审计依赖已冻结 |

因此当前可以说“实现链基本完成”，但不能说“实验 14B 外部真实性结论完成”。最终完成必须同时出现 GP0、GP1、Radar、RIPE、M-Lab 的合格未来数据，并由 `final-evidence-chain-addendum/audit.json` 全部门禁通过证明。
