import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const verificationJsonPath = `${reportDir}/stage1-verification.json`;
const verificationMdPath = `${reportDir}/stage1-verification.md`;

const steps = [
  {
    id: "build",
    title: "生产构建",
    command: "npm run build",
    proves: "TypeScript 类型、Vite 打包和前端产物可生成。",
  },
  {
    id: "templates",
    title: "场景模板导出",
    command: "npm run export:templates",
    proves: "空业务、低负载、正常、高负载、热点、突发和长时业务模板可生成且可校验。",
  },
  {
    id: "dashboard",
    title: "仪表盘浏览器审计",
    command: "npm run audit:dashboard",
    proves: "默认网页入口、指纹、3D/2D 拓扑面板和响应式布局可用。",
  },
  {
    id: "dataset",
    title: "标准上传数据集校验",
    command: "npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv",
    proves: "标准外部业务数据集格式合法，可作为上传数据集验收样例。",
  },
  {
    id: "dataset-json",
    title: "标准 JSON 上传数据集校验",
    command: "npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.json",
    proves: "标准外部业务数据集的 JSON 文件级结构合法，可作为仪表盘上传和第一阶段复现实验样例。",
  },
  {
    id: "assessment",
    title: "第一阶段成熟度评估",
    command: "npm run assess:stage1",
    proves: "自动验收、参数基线、场景矩阵和成熟度报告全部刷新并通过。",
  },
  {
    id: "business-trace",
    title: "标准业务响应追踪导出",
    command: "npm run trace:stage1",
    proves: "标准上传业务可导出任务路径、链路影响和节点状态影响追踪，用于解释业务输入如何改变网络真值。",
  },
  {
    id: "freeze-manifest",
    title: "第一阶段可复现实验冻结清单",
    command: "npm run freeze:stage1",
    proves: "汇总配置、数据集、真值、schema、报告和复现命令指纹，形成第二阶段 INT 对照前的真值底座清单。",
  },
  {
    id: "exports",
    title: "真值导出审计",
    command: "npm run audit:exports",
    proves: "节点、链路、路由、指标、完整 JSON 和复现指纹导出可用。",
  },
];

function tail(text, maxLines = 14) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines)
    .join("\n");
}

async function runStep(step) {
  const startedAt = Date.now();
  try {
    const result = await execAsync(step.command, {
      cwd: process.cwd(),
      maxBuffer: 96 * 1024 * 1024,
      env: process.env,
    });
    return {
      id: step.id,
      title: step.title,
      passed: true,
      duration_ms: Date.now() - startedAt,
      command: step.command,
      proves: step.proves,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
    };
  } catch (error) {
    return {
      id: step.id,
      title: step.title,
      passed: false,
      duration_ms: Date.now() - startedAt,
      command: step.command,
      proves: step.proves,
      stdout_tail: tail(error.stdout ?? ""),
      stderr_tail: tail(error.stderr ?? error.message ?? ""),
    };
  }
}

function markdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function verificationMarkdown(report) {
  const lines = [
    "# 第一阶段总验证报告",
    "",
    `生成时间：${report.generated_at}`,
    "",
    `总体结论：${report.overall_passed ? "通过" : "未通过"}`,
    "",
    `总耗时：${report.duration_ms} ms`,
    "",
    "## 验证步骤",
    "",
    markdownTableRow(["步骤", "结果", "耗时 ms", "证明内容"]),
    markdownTableRow(["---", "---", "---", "---"]),
    ...report.steps.map((step) =>
      markdownTableRow([step.title, step.passed ? "通过" : "未通过", String(step.duration_ms), step.proves]),
    ),
    "",
    "## 关键产物",
    "",
    ...report.artifacts.map((artifact) => `- ${artifact}`),
    "",
  ];

  const failed = report.steps.filter((step) => !step.passed);
  if (failed.length > 0) {
    lines.push("## 失败输出");
    lines.push("");
    for (const step of failed) {
      lines.push(`### ${step.title}`);
      lines.push("");
      lines.push("```text");
      lines.push(step.stderr_tail || step.stdout_tail || "无输出");
      lines.push("```");
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

const startedAt = Date.now();
const results = [];

for (const step of steps) {
  const result = await runStep(step);
  results.push(result);
  if (!result.passed) break;
}

let assessment = null;
try {
  assessment = JSON.parse(await readFile(`${reportDir}/stage1-model-assessment.json`, "utf8"));
} catch {
  assessment = null;
}

const report = {
  generated_at: new Date().toISOString(),
  overall_passed: results.length === steps.length && results.every((step) => step.passed),
  duration_ms: Date.now() - startedAt,
  assessment_summary: assessment
    ? {
        readiness: assessment.readiness,
        score: assessment.score,
        max_score: assessment.max_score,
        config_fingerprint: assessment.parameter_baseline?.config_fingerprint,
        scenario_count: assessment.scenario_matrix?.scenario_count,
      }
    : null,
  steps: results,
  artifacts: [
    "reports/stage1/stage1-acceptance.json",
    "reports/stage1/stage1-model-assessment.json",
    "reports/stage1/stage1-parameter-baseline.json",
    "reports/stage1/stage1-scenario-matrix.json",
    "reports/stage1/stage1-scenario-matrix.csv",
    "reports/stage1/stage1-business-trace.json",
    "reports/stage1/stage1-business-task-trace.csv",
    "reports/stage1/stage1-business-link-impact.csv",
    "reports/stage1/stage1-business-node-impact.csv",
    "reports/stage1/stage1-freeze-manifest.json",
    "reports/stage1/stage1-freeze-manifest.md",
    "reports/stage1/stage1-dashboard-audit.json",
    "reports/stage1/stage1-dashboard-audit.md",
    "schemas/task-dataset-file.schema.json",
    "schemas/task-dataset.schema.json",
    "examples/datasets/stage1-standard-traffic.csv",
    "examples/datasets/stage1-standard-traffic.json",
    "examples/datasets/templates/manifest.json",
  ],
};

await mkdir(reportDir, { recursive: true });
await writeFile(verificationJsonPath, JSON.stringify(report, null, 2), "utf8");
await writeFile(verificationMdPath, verificationMarkdown(report), "utf8");

console.log(
  JSON.stringify(
    {
      overall_passed: report.overall_passed,
      duration_ms: report.duration_ms,
      assessment_summary: report.assessment_summary,
      files: [verificationJsonPath, verificationMdPath],
      steps: report.steps.map((step) => ({
        id: step.id,
        passed: step.passed,
        duration_ms: step.duration_ms,
      })),
    },
    null,
    2,
  ),
);

if (!report.overall_passed) {
  process.exitCode = 1;
}
