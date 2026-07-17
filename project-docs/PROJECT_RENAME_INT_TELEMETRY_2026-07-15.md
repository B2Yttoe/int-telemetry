# 项目名称迁移记录：INT-Temerity -> INT-Telemetry

## 迁移目的

项目早期误将 `Telemetry` 拼写为 `Temerity`。本次迁移将项目主目录、工程标识和仍在使用的路径统一为 `INT-Telemetry`，同时保留读取旧实验产物所需的兼容能力。

## 当前规范名称

| 项目 | 迁移后值 |
|---|---|
| Windows 根目录 | `E:\INT-Telemetry` |
| npm 包名 | `int-telemetry-walker-network` |
| 大写环境变量前缀 | `INT_TELEMETRY_` |
| WSL 新安装默认名称 | `INT-Telemetry-Debian` |
| 自定义事件前缀 | `telemetry-` |
| 新生成数据 schema 前缀 | `int-telemetry-` |

## 已级联修改的范围

- 根目录、根 README、项目文档索引和使用说明中的当前项目名称与示例路径。
- `package.json`、`package-lock.json` 中的 npm 包标识。
- TypeScript/JavaScript 源码中的新 schema、错误信息、下载文件名和浏览器自定义事件。
- PowerShell、WSL、ns-3 与实验脚本中的工作目录、任务名和环境变量名。
- 活跃配置、示例数据和公开轨道快照元数据中的项目路径。
- Word 技术报告文件名、正文、页眉页脚和核心属性。
- Windows 任务计划程序中的项目任务名、脚本路径和工作目录。

## 兼容与证据边界

以下旧值不是遗漏，而是有意保留：

1. 读取器继续接受旧版 `int-temerity-*` schema；新产物只写入 `int-telemetry-*` schema。
2. 已安装的 WSL 发行版 `INT-Temerity-Debian` 不执行高风险导出/导入改名；新环境变量将其作为兼容后端使用，新安装则采用正确名称。
3. `reports/` 与 `stage2-int/runs/` 中冻结实验的旧绝对路径、manifest、日志和哈希证据保持原样。改写这些文件会破坏历史实验的完整性与可复现性。
4. 论文或报告引用历史命令输出时，出现旧路径表示该实验确实在迁移前运行，不代表当前入口仍使用旧名称。

## 验收原则

- 当前代码、配置、脚本和文档应从 `E:\INT-Telemetry` 正常构建与运行。
- 旧 schema 数据仍可导入，新 schema 由当前代码生成。
- Windows 定时任务应只调用新根目录下的脚本。
- 历史冻结产物不因本次名称修正而重新计算或重新签名。
- 全项目允许出现旧名称的位置仅限兼容别名、旧 WSL 发行版名和冻结实验记录。

## 迁移完成状态

- 物理根目录已由 `E:\INT-Temerity` 更名为 `E:\INT-Telemetry`，旧目录已不存在。
- Windows 实验 14B 计划任务已迁移为 `INT-Telemetry-Experiment14B-*`；未来任务使用新脚本路径，已完成的一次性任务保持禁用。
- 用户环境变量已迁移到 `INT_TELEMETRY_WSL_DISTRO` 和 `INT_TELEMETRY_NS3_ROOT`。现有 WSL 发行版仍使用历史名称 `INT-Temerity-Debian`，仅作为兼容后端。
- 实验 14B 核心冻结守卫逐一验证 12 个冻结文件，并以 `aggregate_path_relocated=true` 明确记录绝对根路径变化。
- 实验 14B 原始 31 文件依赖闭包及其哈希保持不变；额外的项目改名 amendment 精确登记 14 个迁移后文件哈希，未登记的后续修改仍会触发失败。
- 生产构建、三种星座配置、实验 8 因果回放、实验 9 跨历元轨道、实验 12、实验 13、实验 14 和实验 14B 验收均已在新根目录通过。
