# 项目存储瘦身记录（2026-07-15）

## 1. 清理结果

本次清理针对旧实验运行、调试缓存、重复快照和可重新生成的逐次运行数据，不修改第一阶段卫星模型、第二阶段 INT/INT-MC 算法、第三阶段系统验证代码，也不删除冻结外部数据和正式实验汇总结果。

| 项目 | 清理前 | 清理后 | 变化 |
|---|---:|---:|---:|
| 工作区逻辑大小 | 约 94.47 GiB | 约 4.76 GiB | 释放约 89.71 GiB |
| `reports` | 约 90.15 GiB | 约 4.32 GiB | 删除重复与可再生展开数据 |
| `stage2-int` | 约 3.73 GiB | 约 0.10 GiB | 仅保留三个代表性运行 |
| 紧凑运行元数据 | 无 | 约 0.30 GiB | 新增 5,399 个轻量证据文件 |

大小由 Git for Windows 的 `du` 按逻辑文件大小统计。Windows 资源管理器显示的“占用空间”可能因簇大小、压缩和稀疏文件而略有不同。

## 2. 保留内容

- 全部项目代码：`src`、`scripts`、`stage2-int/tools`、`stage3-system-validation`。
- 全部配置、schema、示例业务输入、TLE/GP/OMM 快照和外部校准数据。
- README、使用指南、技术报告和论文准备材料。
- 实验 1、2、3、4、5、6、7、8、9、10、11、12、13、14、14B 的正式汇总 CSV、JSON、HTML、Markdown、图表和 manifest。
- 实验 12 统计验证的 18 个逐场景 `results/summary/audit/report` 文件。
- 实验 10、11、12 定向确认、12 自适应泛化、13 和 14/14B 等仍有独立价值且体量可控的结果目录。
- Stage 2 三个代表性运行：`ml-48-traffic`、`reproduce-48-slices`、`reproduce-int-process`。
- 项目完整技术报告：`project-docs/INT-Telemetry_项目改进与实验完整技术报告.docx`。

## 3. 删除内容

### 临时数据

- `.tmp`。
- `reports/_scratch`。
- `reports/tmp-*` 和文档渲染临时目录。
- Stage 2 中旧的 smoke、goal-e2e、调参和审计运行。

### 被最终版本替代的实验副本

- `reports/_archive` 中的旧归档副本。
- 旧版实验 2 增强比较完整展开目录。
- 实验 12 的早期 48 时间片 pilot、stress00、optimized、optimized-v2、final 和 contribution 迭代副本。

这些目录中的小型 manifest、summary、results、audit 和 report 文件在删除前提取到了 `reports/_compact-run-metadata`。

### 可重新生成的正式实验展开数据

- 实验 3 单指标运行中的三套完整星座展开数据。
- 实验 4、6、8 的 `runs` 原始目录。
- importance-aware 中大型试验的完整逐运行数据。
- 实验 12 统计证据中每个场景的内部 `runs` 与重新生成的 `stress-root`。

正式汇总结果仍在原实验目录中。实验 12 每个场景的最终结果、摘要、因果审计和 HTML 报告也仍在原位置。

## 4. 紧凑证据目录

清理清单位于：

```text
reports/_compact-run-metadata/cleanup-manifest.json
```

该清单记录：

- 清理时间与工作区根目录；
- 160 个删除目标及其类别；
- 143 组提取后的轻量元数据；
- 保留的 Stage 2 代表性运行；
- 本次清理遵循的保留策略。

紧凑证据目录不是完整原始运行的压缩包，而是用于追踪配置、结果摘要和报告关系的轻量索引。完整逐节点、逐链路和逐时间片原始展开数据仍应通过固定脚本重新生成。

## 5. 重新生成原始运行

常用正式实验可通过以下命令重建：

```powershell
npm run experiment4:ablation
npm run experiment6:sampling
npm run experiment8:dynamicity
npm run experiment8:reporting-sensitivity
npm run experiment8:reference-replay
npm run experiment12:reuse-statistics
```

Stage 2 INT 运行可使用：

```powershell
npm run int:experiment -- --tasks examples/datasets/stage1-standard-traffic.csv --out stage2-int/runs/<run-name>
```

大型实验重新生成成本较高，应优先使用现有汇总结果；只有需要审计某个逐跳记录、改变参数或重新计算置信区间时才重跑原始数据。

## 6. 后续清理方法

安全清理脚本默认为预览模式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-old-experiment-data.ps1
```

确认预览后执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-old-experiment-data.ps1 -Execute
```

脚本在每次递归删除前都会解析绝对路径，并拒绝操作工作区根目录或任何工作区外路径。正式实验原始运行被删除前会再次提取小型元数据。

## 7. 验收结果

清理后已完成以下验收：

- `npm run build`：通过。
- `npm run test:experiments4-7-reports`：通过，4 份根报告和 16 个链接产物有效。
- `npm run test:experiment12:reuse-statistics`：通过，18 个预注册场景设计仍有效。
- `npm run test:experiment13`：通过。
- `npm run test:experiment14`：通过。
- `npm run test:experiment14b`：通过，冻结协议和 12 个文件的完整性校验有效。
- 实验 12 保留逐场景结果数量：18。
- 实验 12 已删除展开原始目录数量复核：剩余 0。
- 清理后未重新生成 `reports/_scratch` 或 `reports/tmp-*`。

本次瘦身不会改变已经得到的实验数值。需要注意的是，已删除的完整原始运行不能仅凭汇总文件恢复到逐记录粒度；其可复现性由代码、固定配置、输入数据、manifest 和正式实验命令共同保证。
