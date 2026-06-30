# 项目文档归档索引

本目录用于集中存放从根目录清理出来的阶段性说明文件、截图资源和临时运行产物。根目录现在只保留新的 `README.md` 作为项目入口，详细历史资料统一从这里查阅。

## 目录结构

```text
project-docs/
  README.md
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

## 使用建议

- 日常启动、验证、导出和整体理解：优先看根目录 `README.md`。
- 需要查某个旧版细节：看 `legacy-root-docs/`。
- 需要截图材料：看 `assets/`。
- `archived-runtime-artifacts/` 只保存清理根目录时移入的临时日志、截图和临时运行目录，不作为正式实验结果。
