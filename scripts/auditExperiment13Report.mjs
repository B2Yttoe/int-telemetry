import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = resolve("reports/experiment13-system-validation/index.html");
const outputDir = resolve("reports/experiment13-system-validation/qa");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
    });
    await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
    const audit = await page.evaluate(() => ({
      title: document.title,
      language: document.documentElement.lang,
      body_width: document.body.scrollWidth,
      viewport_width: window.innerWidth,
      tables: document.querySelectorAll("table").length,
      bars: document.querySelectorAll(".bar-row").length,
      has_mojibake: /[瀹楠绯][^\n]{0,5}[為岃荤]/u.test(document.body.innerText),
      evidence_complete: document.body.innerText.includes("ns-3 包级系统交叉验证已完整运行"),
    }));
    await page.screenshot({
      path: resolve(outputDir, `${viewport.name}.png`),
      fullPage: true,
    });
    if (viewport.name === "mobile") {
      await page.screenshot({
        path: resolve(outputDir, "mobile-top.png"),
        fullPage: false,
      });
    }
    console.log(`${viewport.name}: ${JSON.stringify(audit)}`);
    await page.close();
  }
} finally {
  await browser.close();
}
