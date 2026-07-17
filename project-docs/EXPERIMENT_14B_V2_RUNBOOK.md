# 实验 14B v2：严格外部验证运行指南

## 1. 为什么新建 v2

原实验 14B 的拓扑 CSV 仍保持锁定哈希，但旧采集器在项目目录改名后覆盖了原 GP0 和 Walker 映射快照。原结果因此只能保留为历史 M-Lab 留出测试和 ns-3 证据，不能继续升级为可复现的 GP0 到 GP1 轨道盲测。

v2 使用独立目录：

```text
reports/experiment14b-prospective-external-validation-v2-utc-corrected
```

原实验目录不会被删除或重写。

### 1.1 UTC 历元纠错与旧 v2 退役

第一次 v2 冻结后发现，CelesTrak OMM 的 `EPOCH` 字段不带时区后缀。`satellite.js` 的 SGP4 传播会按 UTC 正确处理该字段，但项目中用于轨道年龄、相位采样、Walker 槽位排序和生成 TLE 历元的辅助逻辑曾直接调用本地时区 `Date` 解析。在 UTC+8 主机上，这会把轨道年龄系统性高估 8 小时，并可能改变同轨卫星的槽位映射。

该问题是在 GP1、Radar、RIPE 和 M-Lab 未来结果出现之前发现的。旧 v2 已通过以下记录正式退役，不得作为实验 14B 的最终证据：

```text
reports/experiment14b-prospective-external-validation-v2/UTC_EPOCH_RETIREMENT.json
```

校正版本统一把无时区轨道历元规范化为显式 UTC，增加跨 `Asia/Shanghai` 与 `UTC` 的映射一致性测试，并重新执行了主冻结和所有结果前子冻结。校正协议位于：

```text
scripts/experiments/experiment14b-v2-utc-epoch-correction.json
```

正式证据只能来自带 `-utc-corrected` 后缀的目录。校正不是对测试结果调参，因为旧版本退役时未来外部结果计数为 0，且校正版本在重新获取 GP0 前已经冻结。

## 2. 固定原则

- GP0 必须在协议冻结后、且外部源内容发生更新后获取。
- GP0 的原始 GP、Walker 映射、节点和链路 CSV 均写入不可变哈希锁。
- 后续采集不得覆盖 GP0。
- GP1 使用与 GP0 相同的标准 GP 或 Supplemental GP 源族，至少晚 24 小时，且内容哈希必须改变。
- Radar 测试数据不得参与业务参数拟合。
- M-Lab 测试值不得参与 RTT/吞吐参数拟合或区间校准。
- RIPE Atlas 必须使用 AS14593 探针到固定地理锚点的自定义测量；公共 anycast 结果不能通过严格门禁。
- CPU、电量和队列只声明物理方程可信度与同模型相对实验有效性。

## 3. 当前冻结窗口

正式冻结时间及窗口以以下文件为准：

```text
reports/experiment14b-prospective-external-validation-v2-utc-corrected/freeze-manifest.json
```

查看当前状态：

```powershell
npm run experiment14b:v2:status
npm run experiment14b:v2:verify
```

## 4. GP0 与拓扑

到达 `gp0_not_before` 后执行：

```powershell
npm run experiment14b:v2:gp0
```

也可以使用只等待冻结门禁、不修改协议的恢复脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resumeExperiment14BV2.ps1 -WaitForGp0 -PollMinutes 15 -MaximumWaitHours 6 -Reason scheduled-gp0
```

脚本会先验证冻结哈希，再等待到合法时刻并执行 GP0。若源内容尚未更新，它会按固定间隔进行有界重试；到达最大等待时间后仍保持 pending，不会使用旧快照、无限下载或覆盖锁定文件。

程序会同时获取标准 GP 和 Supplemental GP，只接受：

- 获取时间满足因果门禁；
- 内容哈希不同于冻结时基线；
- 72x22 壳层在窗口起点和终点都通过 P50/P95 年龄门禁。

成功后生成：

```text
gp0-lock.json
orbit/gp0/gp0-walker-72x22.json
topology/nodes.csv
topology/links.csv
mlab/strict-window-query.sql
```

## 5. GP1 跨历元盲测

到达 `gp0-lock.json` 中的 `gp1_not_before` 后执行：

```powershell
npm run experiment14b:v2:gp1
```

只有同源、哈希更新且通过年龄门禁的 GP1 才会生成跨历元误差和 `gp1-lock.json`。

有界自动等待入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resumeExperiment14BV2Gp1.ps1 -PollMinutes 30 -MaximumGp0WaitHours 12 -MaximumGp1SourceWaitHours 12
```

## 6. Cloudflare Radar 与 RIPE Atlas

凭据只放入环境变量，不写入仓库。若准备立即在当前终端手工执行，可以使用进程级变量：

```powershell
$env:CLOUDFLARE_API_TOKEN = "<Radar Read token>"
$env:RIPE_ATLAS_API_KEY = "<measurement creation key>"
npm run experiment14b:v2:external
```

若 `resumeExperiment14BV2Radar.ps1` 已经作为后台进程启动，之后在另一个终端设置 `$env:` 不会进入旧进程。此时应写入当前 Windows 用户环境；守护脚本每次轮询都会重新读取用户/机器级变量：

```powershell
[Environment]::SetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "<Radar Read token>", "User")
```

实验结束后可清除：

```powershell
[Environment]::SetEnvironmentVariable("CLOUDFLARE_API_TOKEN", $null, "User")
```

Radar 会等待冻结的 48 小时测试窗口结束后再抓取。RIPE 在首次检测到 API key 时，先冻结四小时测量窗口，再创建固定锚点测量。

Radar 也可以使用有界自动恢复入口。脚本会从进程、用户和机器环境变量中读取 token，但不会记录 token；未来窗口结束前不采集，成功生成分数后不再重复覆盖：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resumeExperiment14BV2Radar.ps1 -PollMinutes 15 -MaximumWaitHoursAfterWindow 24
```

Radar 采集完成后还会执行预冻结的因果状态附录。该附录重新读取冻结的校准与测试窗口，检查时间戳无重叠、小时序列无大缺口，并仅用校准段复算回归系数和区间半径；只有复算结果与原分数完全一致时，才向总状态写入 `test_values_used_for_fit = 0`、`test_values_used_for_interval_calibration = 0` 和 `post_test_parameter_updates = 0`。这一步修复的是状态证据传播，不会修改 Radar 值、系数、业务权重或模型参数。

若没有 RIPE measurement-creation key，可使用已在 GP0 前预注册的公开固定锚点测量：

```powershell
npm run experiment14b:v2:ripe-public:preflight
npm run experiment14b:v2:ripe-public:collect
```

自动等待 GP0 和窗口结束：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resumeExperiment14BV2PublicRipe.ps1 -PollMinutes 10 -MaximumWaitHours 12
```

该备选源固定为测量 `34468267`、Starlink AS14593 探针 `1003040` 和 Dubai Anchor `2825`。它是持续测量的单播固定 IP `80.77.4.60`，不同于 K-root 等 anycast 公共代理。只有 GP0 拓扑窗口结束后产生的新结果会被读取，历史结果不进入正式评分；若端点、探针 ASN、在线状态或直接坐标发生变化，预检会拒绝采集。

## 7. 严格 M-Lab 数据

GP0 完成后会生成官方 BigQuery 查询模板：

```text
reports/experiment14b-prospective-external-validation-v2-utc-corrected/mlab/strict-window-query.sql
```

在 M-Lab 数据完成发布后执行查询并导出 CSV，同时保存查询元数据 JSON。元数据至少应记录：

- 官方表名；
- 查询文本或查询哈希；
- BigQuery job ID；
- 执行和下载时间；
- 导出行数；
- 数据许可与来源地址。

正式导入前必须先通过来源证明附加门禁。它会核验官方表、冻结 SQL 哈希、BigQuery job ID、查询完成时间、导出行数、原始 CSV 哈希和零测试集回调，并在导入前生成不可覆盖的输入锁：

```powershell
npm run experiment14b:v2:mlab:provenance:preflight -- `
  --mlab-csv <export.csv> `
  --mlab-metadata <query-metadata.json>

npm run experiment14b:v2:mlab:provenance:import -- `
  --mlab-csv <export.csv> `
  --mlab-metadata <query-metadata.json>
```

`query-metadata.json` 必须包含 `official_table`、`query_sha256`、`bigquery_job_id`、`query_started_at`、`query_completed_at`、`exported_at`、`row_count`、`source_csv_sha256`、`source_url`、`license`、`test_values_used_for_fit=0` 和 `post_test_parameter_updates=0`。查询完成时间必须晚于 GP0 锁定的 M-Lab 发布延迟门禁。

严格样本必须同时满足：

- 时间落在冻结拓扑窗口内，距离最近时间片不超过 150 秒；
- 客户端坐标为测量记录直接提供；
- M-Lab 服务器具有明确 ID 和直接地理坐标；
- 客户 ASN 为 14593，协议为 NDT7；
- 至少获得 20 个合格样本。

历史月度数据映射到代表性轨道相位、城市质心或国家质心的样本会被自动拒绝。

### 7.1 RTT 与吞吐口径

严格测试采用 M-Lab NDT Unified Downloads 的两个标准字段：

- `a.MinRTT`：客户端与被选中 M-Lab 服务器之间观测到的最小往返时延，单位为毫秒；
- `a.MeanThroughputMbps`：下载测试期间的平均吞吐率，单位为 Mbit/s。

模型侧 RTT 使用相同的端到端边界：用户终端到接入卫星、星间路径、网关下行、网关到具体 M-Lab 服务器的地面传输以及固定处理时延，最后按往返路径计算。在冻结拓扑窗口使用空业务场景，瞬时业务排队不会被误当成 NDT 最小 RTT；历史校准只估计固定接入/传输偏置。吞吐预测使用接入 SGL、ISL、网关容量和逐链路成功率形成的端到端瓶颈容量，再乘以仅由校准集拟合的调度份额。

官方字段说明：

> 查询语义修正：M-Lab 官方统一视图将 `node._Instruments` 定义为标量协议标识，取值为 `web100`、`tcpinfo` 或 `ndt7`。父实验冻结后发现原模板误用了数组 `UNNEST` 表达式，因此项目在 GP0 和任何未来 M-Lab 结果出现之前冻结了独立修正附录。GP0 锁定后运行 `npm run experiment14b:v2:mlab-query-correction:apply`，最终查询固定使用 `node._Instruments = 'ndt7'`，并由独立哈希锁和审计文件证明修正发生在测试数据读取之前。该修正只纠正字段语义，不改变时间窗口、ASN、指标、配对规则或模型参数。

### 7.2 M-Lab BigQuery 自动采集

项目提供不依赖 `bq` 命令的 BigQuery REST 采集器。它只会在 GP0 指定的公开发布等待期结束、查询语义修正锁通过且 Google 凭据可用时执行。采集器设置 200 GB 单次查询费用硬上限，支持结果分页，并自动生成原始 CSV、BigQuery Job ID、查询/CSV SHA-256、查询时间和零测试集拟合声明，随后进入既有严格导入与配对审计。

M-Lab 当前把 `ndt7_union` 作为一般用途视图，但它包含未经统一质量过滤的 M-Lab-managed 与 Host-Managed 数据。本实验冻结使用 `unified_downloads`，是因为该视图已经排除不完整测试、解析错误、运维测试以及未形成有效拥塞测量的下载记录；随后再用 `node._Instruments = 'ndt7'` 限定协议。代价是查询更复杂，因此采集器同时采用日期分区条件和费用硬上限。这里追求的是盲测样本质量与口径稳定，而不是最低查询费用。

M-Lab 官方将 NDT 研究数据发布在 BigQuery，并要求查询主体具备其公开数据访问权限。首次使用前，需要按照 [M-Lab BigQuery QuickStart](https://www.measurementlab.net/quickstart/) 完成开放数据访问订阅，并准备一个能够创建 BigQuery 查询作业的 Google Cloud 项目。项目只读取 `measurement-lab` 公共数据集，但查询作业仍由调用者项目创建；缺少访问权限、项目 ID 或凭据时属于外部前置条件未满足，而不是允许改用本地合成数据的理由。

凭据可采用以下任一形式：

```powershell
$env:GOOGLE_OAUTH_ACCESS_TOKEN = "短期 OAuth access token"
$env:GOOGLE_CLOUD_PROJECT = "用于创建查询作业的 Google Cloud 项目 ID"
```

或：

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "服务账号 JSON 的绝对路径"
$env:GOOGLE_CLOUD_PROJECT = "可选；未设置时读取 JSON 中的 project_id"
```

对于已经启动的 M-Lab 后台采集器，应使用用户级变量。服务账号文件比短期 OAuth token 更适合等待公开数据发布：

```powershell
[Environment]::SetEnvironmentVariable("GOOGLE_APPLICATION_CREDENTIALS", "服务账号 JSON 的绝对路径", "User")
[Environment]::SetEnvironmentVariable("GOOGLE_CLOUD_PROJECT", "用于创建查询作业的项目 ID", "User")
```

JSON 文件必须位于仓库外，且不得提交到 Git。后台采集器只读取文件路径和凭据，不会把密钥写入实验结果。

启动有界后台采集：

```powershell
npm run experiment14b:v2:mlab-bigquery:resume
```

未提供凭据、发布门尚未开启或数据不足时，采集器只报告 `pending`，不会生成合成数据，也不会覆盖已锁定结果。

- <https://www.measurementlab.net/tests/ndt/ndt7/>
- <https://www.measurementlab.net/tests/ndt/views/migrate/>

测试窗口的 RTT 和吞吐目标值均不得用于拟合偏置、调度份额或预测区间。

## 8. 最终审计

GP0 生成并完成 M-Lab 查询语义锁定后，应在任何未来结果进入前立即冻结总证据链：

```powershell
npm run experiment14b:v2:final-evidence:freeze
```

也可以使用轻量守护脚本自动等待这两个前置锁：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resumeExperiment14BV2FinalEvidenceFreeze.ps1 -PollMinutes 1 -MaximumWaitHours 8
```

该守护脚本只负责冻结与审计，不读取未来测量值，也不改变已经冻结的实验核心。

```powershell
npm run experiment14b:v2:audit
npm run experiment14b:v2:pairing:audit
npm run experiment14b:v2:strict-score
npm run experiment14b:v2:completion:audit
npm run experiment14b:v2:final-evidence:audit
```

只有全部门禁通过，状态才会变为：

```text
strict-prospective-validation-complete
```

缺少 token、未来窗口未结束、数据尚未发布或严格样本不足时，状态保持 `in-progress`，不允许用旧数据、合成数据或公共代理替代。

严格配对附加审计同时要求 M-Lab 与 RIPE Atlas 各自至少有 20 条合格记录。RIPE 记录还必须明确标记为 `fixed-ripe-atlas-anchor`；K-root 等 anycast 公共代理即使时间新鲜，也不能通过该门禁。附加协议及冻结证据位于：

```text
scripts/experiments/experiment14b-v2-strict-pairing-addendum.json
reports/experiment14b-prospective-external-validation-v2-utc-corrected/strict-pairing-addendum/freeze.json
```

最终 RTT/吞吐误差以 `strict-scoring-addendum/score.json` 为准。该文件只使用通过上述严格门禁的记录：M-Lab 同时报告 RTT 与吞吐，RIPE ping 只报告 RTT，不使用不存在的吞吐目标。原导入器生成的全体可建模样本分数保留作诊断，不作为严格外部验证主结果。

若采用预注册公开固定 Anchor，原始 v2 审计仍会把“未由本项目创建测量”显示为 pending。`strict-completion-addendum/audit.json` 负责接受预注册固定 Anchor 与项目自建固定 Anchor 的等价语义；它只放宽测量所有权，不放宽固定端点、直接坐标、样本数、时间配对和零测试集回调要求。

论文与交付阶段的最终判定以 `final-evidence-chain-addendum/audit.json` 为准。该附录在 GP0 已锁定、但 GP1、Radar、RIPE 和 M-Lab 未来结果均未出现时冻结，级联验证主实验冻结、严格配对、严格评分、固定 Anchor、Radar 因果性、M-Lab 查询修正、BigQuery 来源证明、ns-3 结果和声明边界。它不会重新计算或修改任何模型参数，只负责防止后加入的子证据游离在总审计之外。
