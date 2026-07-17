# 项目文档归档索引

本目录用于集中存放从根目录清理出来的阶段性说明文件、截图资源和临时运行产物。根目录现在只保留新的 `README.md` 作为项目入口，详细历史资料统一从这里查阅。

## 目录结构

```text
project-docs/
  README.md
  PROJECT_RENAME_INT_TELEMETRY_2026-07-15.md
  EXPERIMENT_14B_V2_RUNBOOK.md
  EXPERIMENT_14B_IMPLEMENTATION_STATUS.md
  INT-Telemetry_项目改进与实验完整技术报告.docx
  STORAGE_CLEANUP_2026-07-15.md
  legacy-root-docs/
    README.legacy.md
    USAGE_GUIDE.md
    STAGE1_USER_GUIDE.md
    EXPERIMENT_REPRODUCTION_GUIDE.md
    DATASET_FIELD_REFERENCE.md
    REAL_TLE_SNAPSHOT_GUIDE.md
  assets/
    stage1-dashboard-overview.png
    stage1-dashboard-highload.png
    stage1-dashboard-mobile.png
    stage1-dashboard-tables.png
    ui-redesign-desktop.png
    ui-redesign-mobile.png
    ui-redesign-topology.png
  archived-runtime-artifacts/
    tmp-telemetry-page.png
    vite-dev.log
    vite-dev.err.log
    tmp/
    .tmp/
```

## 文档说明

| 文件 | 内容 |
|---|---|
| `legacy-root-docs/README.legacy.md` | 旧版根目录 README，保留早期完整说明。 |
| `legacy-root-docs/USAGE_GUIDE.md` | 仪表盘、业务数据集、导出功能和仿真参数使用说明。 |
| `legacy-root-docs/STAGE1_USER_GUIDE.md` | 第一阶段卫星网络模型、真值导出、参数物理意义和截图说明。 |
| `legacy-root-docs/EXPERIMENT_REPRODUCTION_GUIDE.md` | 实验复现流程、命令和产物读取方法。 |
| `legacy-root-docs/DATASET_FIELD_REFERENCE.md` | 输入业务、第一阶段真值、INT 遥测、Ground OAM 重构数据字段解释。 |
| `legacy-root-docs/REAL_TLE_SNAPSHOT_GUIDE.md` | CelesTrak GP/OMM 快照、真实 TLE + SGP4 模式和真实规模导出说明。 |
| `IMPORTANCE_AWARE_SELECTIVE_TELEMETRY_PILOT.md` | 重要性感知路径、逐跳选择性 metadata、有界 AoI 修复的实现原理、开销口径与短试验结果。 |
| `EXPERIMENT_14B_VALIDITY_BOUNDARIES.md` | 前瞻外部盲测的因果约束、公开可观测量与 CPU/电量/队列等内部潜变量的声明边界。 |
| `EXPERIMENT_14B_V2_RUNBOOK.md` | UTC 校正 v2 的冻结、GP0/GP1、Radar、RIPE、M-Lab 和最终审计运行顺序。 |
| `EXPERIMENT_14B_IMPLEMENTATION_STATUS.md` | 六项目标逐项区分实现完成、验收完成、未来数据待完成和外部凭据条件。 |
| `PROJECT_RENAME_INT_TELEMETRY_2026-07-15.md` | 从历史误拼 `INT-Temerity` 迁移到规范名称 `INT-Telemetry` 的级联修改、兼容边界和验收原则。 |
| `INT-Telemetry_项目改进与实验完整技术报告.docx` | 项目建模、LEO INT-MC 增强、实验 1-14B、数学原理和证据边界的完整技术报告。 |
| `STORAGE_CLEANUP_2026-07-15.md` | 旧实验数据瘦身策略、保留/删除范围、空间变化、再生成命令和验收结果。 |

## 使用建议

- 日常启动、验证、导出和整体理解：优先看根目录 `README.md`。
- 需要查某个旧版细节：看 `legacy-root-docs/`。
- 需要截图材料：看 `assets/`。
- `archived-runtime-artifacts/` 只保存清理根目录时移入的临时日志、截图和临时运行目录，不作为正式实验结果。
