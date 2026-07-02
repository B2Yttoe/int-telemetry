import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const host = "127.0.0.1";
const port = Number(argValue(args, "--port", "5174"));
const url = `http://${host}:${port}`;
const dashboardJsonPath = `${reportDir}/stage1-dashboard-audit.json`;
const dashboardMdPath = `${reportDir}/stage1-dashboard-audit.md`;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServer(targetUrl, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(targetUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${targetUrl}`);
}

async function launchBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);

  const executablePath = candidates.find((candidate) => existsSync(candidate));
  if (executablePath) return chromium.launch({ headless: true, executablePath });
  return chromium.launch({ headless: true });
}

function terminateServer(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function markdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function dashboardMarkdown(report) {
  const activeControls = report.default_state?.active_controls ?? [];
  const fingerprints = report.default_state?.fingerprints ?? [];
  const lines = [
    "# 第一阶段仪表盘审计",
    "",
    `生成时间：${report.generated_at}`,
    "",
    `总体结论：${report.overall_passed ? "通过" : "未通过"}`,
    "",
    `审计地址：${report.url}`,
    "",
    "## 检查项",
    "",
    markdownTableRow(["检查项", "结果"]),
    markdownTableRow(["---", "---"]),
    ...Object.entries(report.checks).map(([key, passed]) => markdownTableRow([key, passed ? "通过" : "未通过"])),
    "",
    "## 默认状态",
    "",
    ...(activeControls.length > 0 ? activeControls.map((control) => `- ${control}`) : ["- 未采集"]),
    "",
    "## 指纹",
    "",
    ...(fingerprints.length > 0 ? fingerprints.map((item) => `- ${item.label}: ${item.value}`) : ["- 未采集"]),
    "",
  ];

  if (report.error) {
    lines.push("## 错误");
    lines.push("");
    lines.push("```text");
    lines.push(report.error);
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

const serverCommand = `npm run dev -- --host ${host} --port ${port} --strictPort`;
const server = spawn(serverCommand, {
  cwd: process.cwd(),
  shell: true,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverStdout = "";
let serverStderr = "";
server.stdout.on("data", (chunk) => {
  serverStdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverStderr += chunk.toString();
});

let browser;
let report;

try {
  await waitForServer(url);
  browser = await launchBrowser();

  const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await desktopPage.goto(url, { waitUntil: "networkidle" });
  const desktop = await desktopPage.evaluate(() => {
    const fingerprintLabels = ["配置指纹", "数据集指纹", "真值指纹"];
    const fingerprints = fingerprintLabels.map((label) => {
      const element = [...document.querySelectorAll(".truth-summary-item")].find((node) =>
        node.textContent?.includes(label),
      );
      return {
        label,
        present: Boolean(element),
        value: element?.querySelector("strong")?.textContent?.trim() ?? "",
      };
    });

    return {
      title: document.querySelector("h1")?.textContent?.trim() ?? "",
      active_controls: [...document.querySelectorAll(".mode-switch button.active")].map((element) =>
        element.textContent?.trim(),
      ),
      export_buttons: [...document.querySelectorAll(".export-actions button")].map((element) =>
        element.textContent?.trim(),
      ),
      table_headers: [...document.querySelectorAll("th")].map((element) => element.textContent?.trim()),
      fingerprints,
      has_truth_panel: Boolean(document.querySelector(".truth-panel")),
      has_orbital_canvas: Boolean(document.querySelector("canvas")),
      has_planar_topology: Boolean(document.querySelector(".planar-panel")),
      has_horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await mobilePage.goto(url, { waitUntil: "networkidle" });
  const mobile = await mobilePage.evaluate(() => ({
    has_horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    has_truth_panel: Boolean(document.querySelector(".truth-panel")),
  }));

  const expectedControls = ["真实运行", "最短路径", "正常业务", "TLE + SGP4"];
  const expectedExportButtons = ["完整 JSON", "节点 CSV", "链路 CSV", "路由 CSV", "指标 CSV", "任务追踪", "链路影响", "节点影响"];
  const checks = {
    "dashboard title is present": desktop.title === "动态拓扑全网感知仪表盘",
    "default controls match stage-one baseline": expectedControls.every((control) =>
      desktop.active_controls.includes(control),
    ),
    "fingerprints are visible": desktop.fingerprints.every((item) => item.present && item.value.length > 0),
    "default normal dataset fingerprint is stable": desktop.fingerprints.some(
      (item) => item.label === "数据集指纹" && item.value === "e875b03a",
    ),
    "default normal truth fingerprint is stable": desktop.fingerprints.some(
      (item) => item.label === "真值指纹" && item.value === "0f5fff04",
    ),
    "truth panel is present": desktop.has_truth_panel,
    "business trace export buttons are present": expectedExportButtons.every((button) =>
      desktop.export_buttons.includes(button),
    ),
    "route table exposes per-task service results": ["优先级", "需求/承载", "排队/丢弃", "遥测增量"].every((header) =>
      desktop.table_headers.includes(header),
    ),
    "orbital canvas is present": desktop.has_orbital_canvas,
    "planar topology is present": desktop.has_planar_topology,
    "desktop has no horizontal overflow": !desktop.has_horizontal_overflow,
    "mobile has no horizontal overflow": !mobile.has_horizontal_overflow,
    "mobile truth panel is present": mobile.has_truth_panel,
  };

  report = {
    generated_at: new Date().toISOString(),
    url,
    overall_passed: Object.values(checks).every(Boolean),
    checks,
    default_state: desktop,
    mobile,
  };
} catch (error) {
  report = {
    generated_at: new Date().toISOString(),
    url,
    overall_passed: false,
    checks: {
      "dashboard audit completed": false,
    },
    error: error instanceof Error ? error.message : String(error),
    server_stdout_tail: serverStdout.split(/\r?\n/).filter(Boolean).slice(-12).join("\n"),
    server_stderr_tail: serverStderr.split(/\r?\n/).filter(Boolean).slice(-12).join("\n"),
  };
} finally {
  if (browser) await browser.close();
  terminateServer(server);
}

await mkdir(reportDir, { recursive: true });
await writeFile(dashboardJsonPath, JSON.stringify(report, null, 2), "utf8");
await writeFile(dashboardMdPath, dashboardMarkdown(report), "utf8");

console.log(
  JSON.stringify(
    {
      overall_passed: report.overall_passed,
      files: [dashboardJsonPath, dashboardMdPath],
      checks: report.checks,
    },
    null,
    2,
  ),
);

if (!report.overall_passed) {
  process.exitCode = 1;
}
