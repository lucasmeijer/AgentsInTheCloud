import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chartSvg, escapeXml, type CheckResult, type Trace } from "./trace.ts";

export interface ScenarioResult {
  name: string;
  description: string;
  checks: CheckResult[];
  files: string[];
}

export class Report {
  readonly scenarios: ScenarioResult[] = [];

  constructor(readonly directory: string, readonly title: string, readonly context: Record<string, string>) {}

  async scenario(name: string, description: string): Promise<ScenarioRecorder> {
    const directory = join(this.directory, name);
    await mkdir(directory, { recursive: true });
    const result: ScenarioResult = { name, description, checks: [], files: [] };
    this.scenarios.push(result);
    return new ScenarioRecorder(directory, result);
  }

  async write(): Promise<{ passed: boolean; index: string }> {
    const passed = this.scenarios.every((scenario) => scenario.checks.every((check) => check.pass));
    await writeFile(join(this.directory, "summary.json"), `${JSON.stringify({ title: this.title, passed, context: this.context, scenarios: this.scenarios }, null, 2)}\n`);
    const rows = this.scenarios.map((scenario) => {
      const ok = scenario.checks.every((check) => check.pass);
      const checks = scenario.checks.map((check) => `<tr class="${check.pass ? "pass" : "fail"}"><td>${check.pass ? "✔" : "✘"}</td><td>${escapeXml(check.name)}</td><td>${escapeXml(check.evidence)}${check.note ? `<br><em>${escapeXml(check.note)}</em>` : ""}</td></tr>`).join("");
      const media = scenario.files.map((file) => file.endsWith(".png") || file.endsWith(".svg")
        ? `<a href="${scenario.name}/${file}"><img src="${scenario.name}/${file}" alt="${escapeXml(file)}"></a>`
        : file.endsWith(".mp4") || file.endsWith(".mov")
          ? `<video src="${scenario.name}/${file}" controls muted></video>`
          : `<a href="${scenario.name}/${file}">${escapeXml(file)}</a>`).join("");
      return `<section id="${scenario.name}"><h2 class="${ok ? "pass" : "fail"}">${ok ? "PASS" : "FAIL"} — ${escapeXml(scenario.name)}</h2><p>${escapeXml(scenario.description)}</p>
<table>${checks}</table><div class="media">${media}</div></section>`;
    }).join("\n");
    const summary = this.scenarios.map((scenario) => {
      const ok = scenario.checks.every((check) => check.pass);
      return `<li class="${ok ? "pass" : "fail"}"><a href="#${scenario.name}">${ok ? "PASS" : "FAIL"} ${escapeXml(scenario.name)}</a> (${scenario.checks.filter((check) => check.pass).length}/${scenario.checks.length})</li>`;
    }).join("");
    const context = Object.entries(this.context).map(([key, value]) => `<li><b>${escapeXml(key)}</b>: ${escapeXml(value)}</li>`).join("");
    const html = `<!doctype html><meta charset="utf-8"><title>${escapeXml(this.title)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:1200px;color:#222}.pass{color:#17803d}.fail{color:#b42318}table{border-collapse:collapse;width:100%;margin:8px 0}td{border-top:1px solid #eee;padding:4px 6px;vertical-align:top}td:first-child{width:20px}td:nth-child(2){width:220px;font-weight:600}.chart{max-width:100%;border:1px solid #ddd}.media img{height:360px;margin:6px 6px 0 0;border:1px solid #ddd}.media img[src$=".svg"]{height:auto;max-width:100%}.media>a:not(:has(img)){display:inline-block;margin:4px 12px 4px 0}.media video{height:420px;margin:6px}section{border-top:2px solid #ddd;margin-top:24px}</style>
<h1 class="${passed ? "pass" : "fail"}">${escapeXml(this.title)} — ${passed ? "PASS" : "FAIL"}</h1><ul>${context}</ul><ol>${summary}</ol>${rows}`;
    const index = join(this.directory, "index.html");
    await writeFile(index, html);
    return { passed, index };
  }
}

export class ScenarioRecorder {
  constructor(readonly directory: string, readonly result: ScenarioResult) {}

  add(...checks: CheckResult[]): void {
    this.result.checks.push(...checks);
  }

  private traces = 0;

  async trace(trace: Trace, title: string): Promise<void> {
    this.traces += 1;
    await this.file(`trace-${this.traces}.json`, JSON.stringify({ title, ...trace }));
    await this.file(`chart-${this.traces}.svg`, chartSvg(trace, title));
  }

  async file(name: string, data: Uint8Array | string): Promise<void> {
    await writeFile(join(this.directory, name), data);
    if (!this.result.files.includes(name)) this.result.files.push(name);
  }
}
