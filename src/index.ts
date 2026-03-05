import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { fetch } from "undici";
import { z } from "zod";

// Keep this plugin self-contained so it can be built and published independently.
type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerTool: (tool: any, meta?: any) => void;
  registerCli?: (cb: (args: { program: any }) => void, meta?: any) => void;
  registerService?: (svc: { id: string; start: () => void; stop: () => void }) => void;
  on?: (eventName: string, handler: (event: any, ctx: any) => Promise<any> | any) => void;
};

type AionisPreset = "compact" | "policy-first" | "custom";

type AionisConfig = {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  scope: string;
  scopePrefix: string;
  scopeMode: "fixed" | "session" | "project";
  userId: string;
  actor: string;
  preset: AionisPreset;
  autoRecall: boolean;
  autoCapture: boolean;
  autoPolicyFeedback: boolean;
  includeShadow: boolean;
  strictTools: boolean;
  recallLimit: number;
  captureMessageLimit: number;
  contextCharBudget: number;
  debug: boolean;
};

type AionisError = {
  status: number;
  code: string;
  message: string;
  details?: unknown;
};

type ToolDecision = {
  decision_id?: string;
  decision_uri?: string;
  selected?: string | null;
  selected_tool?: string | null;
  candidates?: string[];
  request_id?: string | null;
};

type ReplayRunMode = "strict" | "guided" | "simulate";
type ReplaySafetyLevel = "auto_ok" | "needs_confirm" | "manual_only";
type ReplayExecutionBackend = "local_process" | "sandbox_sync" | "sandbox_async";
type ReplaySensitiveReviewMode = "block" | "warn";
type ReplayGuidedRepairStrategy = "deterministic_skip" | "heuristic_patch" | "http_synth" | "builtin_llm";
type ReplayShadowValidationProfile = "fast" | "balanced" | "thorough";
type ReplayShadowValidationExecutionMode = "sync" | "async_queue";

const ConfigSchema = z.object({
  baseUrl: z.string().url().default(process.env.AIONIS_BASE_URL ?? "http://127.0.0.1:3001"),
  apiKey: z.string().default(process.env.AIONIS_API_KEY ?? ""),
  tenantId: z.string().min(1).default(process.env.AIONIS_TENANT_ID ?? "default"),
  scope: z.string().min(1).default(process.env.AIONIS_SCOPE ?? "default"),
  scopePrefix: z.string().min(1).default(process.env.AIONIS_SCOPE_PREFIX ?? "clawbot"),
  scopeMode: z
    .enum(["fixed", "session", "project"])
    .default((process.env.AIONIS_SCOPE_MODE as "fixed" | "session" | "project") ?? "project"),
  userId: z.string().min(1).default(process.env.AIONIS_USER_ID ?? "default"),
  actor: z.string().min(1).default(process.env.AIONIS_ACTOR ?? "openclaw-aionis-plugin"),
  preset: z.enum(["compact", "policy-first", "custom"]).default((process.env.AIONIS_PRESET as AionisPreset) ?? "compact"),
  autoRecall: z.boolean().default(parseBoolean(process.env.AIONIS_AUTO_RECALL, true)),
  autoCapture: z.boolean().default(parseBoolean(process.env.AIONIS_AUTO_CAPTURE, true)),
  autoPolicyFeedback: z.boolean().default(parseBoolean(process.env.AIONIS_AUTO_POLICY_FEEDBACK, true)),
  includeShadow: z.boolean().default(parseBoolean(process.env.AIONIS_INCLUDE_SHADOW, false)),
  strictTools: z.boolean().default(parseBoolean(process.env.AIONIS_TOOLS_STRICT, false)),
  recallLimit: z.number().int().positive().max(50).default(parseIntEnv(process.env.AIONIS_RECALL_LIMIT, 8)),
  captureMessageLimit: z.number().int().positive().max(20).default(parseIntEnv(process.env.AIONIS_CAPTURE_MSG_LIMIT, 8)),
  contextCharBudget: z.number().int().positive().max(50000).default(parseIntEnv(process.env.AIONIS_CONTEXT_CHAR_BUDGET, 3000)),
  debug: z.boolean().default(parseBoolean(process.env.AIONIS_DEBUG, false)),
});

const PRESET_DEFAULTS: Record<Exclude<AionisPreset, "custom">, Pick<AionisConfig, "recallLimit" | "contextCharBudget" | "captureMessageLimit" | "includeShadow" | "strictTools">> = {
  "compact": {
    recallLimit: 6,
    contextCharBudget: 2200,
    captureMessageLimit: 6,
    includeShadow: false,
    strictTools: false,
  },
  "policy-first": {
    recallLimit: 12,
    contextCharBudget: 4200,
    captureMessageLimit: 10,
    includeShadow: true,
    strictTools: true,
  },
};

function parseBoolean(v: string | undefined, fallback: boolean): boolean {
  if (v == null || v === "") return fallback;
  const raw = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseIntEnv(v: string | undefined, fallback: number): number {
  if (v == null || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function toRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function applyPreset(rawCfg: Record<string, unknown>, cfg: AionisConfig): AionisConfig {
  if (cfg.preset === "custom") return cfg;
  const preset = PRESET_DEFAULTS[cfg.preset];
  const out: AionisConfig = { ...cfg };

  if (!hasOwn(rawCfg, "recallLimit")) out.recallLimit = preset.recallLimit;
  if (!hasOwn(rawCfg, "contextCharBudget")) out.contextCharBudget = preset.contextCharBudget;
  if (!hasOwn(rawCfg, "captureMessageLimit")) out.captureMessageLimit = preset.captureMessageLimit;
  if (!hasOwn(rawCfg, "includeShadow")) out.includeShadow = preset.includeShadow;
  if (!hasOwn(rawCfg, "strictTools")) out.strictTools = preset.strictTools;

  return out;
}

function cleanText(input: string, max = 1200): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function sanitizeScope(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "")
    .slice(0, 120);
}

function extractSessionId(event: any, ctx: any): string | null {
  const candidates: Array<unknown> = [
    ctx?.sessionKey,
    ctx?.sessionId,
    ctx?.runId,
    event?.sessionKey,
    event?.sessionId,
    event?.runId,
    event?.run_id,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function extractPrompt(event: any): string {
  if (typeof event?.prompt === "string") return event.prompt.trim();
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as Record<string, unknown>).role;
    if (role !== "user") continue;
    const text = extractMessageText(msg);
    if (text) return text;
  }
  return "";
}

function extractMessageText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const obj = msg as Record<string, unknown>;
  const content = obj.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) chunks.push(text.trim());
    }
    return chunks.join("\n").trim();
  }
  return "";
}

function gatherRecentDialogue(messages: unknown[], maxItems: number): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  const tail = messages.slice(Math.max(0, messages.length - maxItems));
  for (const msg of tail) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as Record<string, unknown>).role;
    if (role !== "user" && role !== "assistant") continue;
    let text = extractMessageText(msg);
    if (!text) continue;
    text = text.replace(/<aionis-context>[\s\S]*?<\/aionis-context>\s*/g, "").trim();
    if (!text) continue;
    out.push({ role: String(role), content: cleanText(text, 2400) });
  }
  return out;
}

function extractWorkspacePath(event: any, ctx: any): string | null {
  const candidates: Array<unknown> = [
    ctx?.workspace,
    ctx?.workspacePath,
    ctx?.workspaceRoot,
    ctx?.cwd,
    ctx?.agent?.workspace,
    event?.workspace,
    event?.workspacePath,
    event?.cwd,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function projectScopeTokenFromPath(pathLike: string): string {
  const base = sanitizeScope(basename(pathLike)) || "project";
  const hash = createHash("sha1").update(pathLike).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function buildScope(cfg: AionisConfig, event: any, ctx: any, sessionId: string | null): string {
  if (cfg.scopeMode === "fixed") return cfg.scope;
  if (cfg.scopeMode === "project") {
    const workspacePath = extractWorkspacePath(event, ctx);
    if (!workspacePath) return cfg.scope;
    return sanitizeScope(`${cfg.scopePrefix}:${projectScopeTokenFromPath(workspacePath)}`) || cfg.scope;
  }
  if (!sessionId) return cfg.scope;
  return sanitizeScope(`${cfg.scopePrefix}:${sessionId}`) || cfg.scope;
}

function summarizeContextAsText(out: any): string {
  const merged = out?.layered_context?.merged_text;
  if (typeof merged === "string" && merged.trim().length > 0) return merged.trim();
  const recallText = out?.recall?.context?.text;
  if (typeof recallText === "string" && recallText.trim().length > 0) return recallText.trim();
  return "";
}

function toToolText(title: string, payload: unknown): { content: Array<{ type: string; text: string }>; details: unknown } {
  return {
    content: [{ type: "text", text: title }],
    details: payload,
  };
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function resolveOpenClawConfigPath(): string {
  const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".openclaw", "openclaw.json");
}

function writeJsonWithBackup(path: string, value: unknown): string {
  if (existsSync(path)) {
    const backupPath = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function autoWritePluginConfigFromClawbotEnv(cfg: AionisConfig): { configPath: string; baseUrl: string; apiKey: string; tenantId: string; scopePrefix: string } {
  const envPath = join(homedir(), ".openclaw", "plugins", "aionis", "clawbot.env");
  const envMap = parseEnvFile(envPath);

  const baseUrl = envMap.AIONIS_BASE_URL ?? cfg.baseUrl;
  const apiKey = envMap.AIONIS_API_KEY ?? cfg.apiKey;
  const tenantId = envMap.AIONIS_TENANT_ID ?? cfg.tenantId;
  const scopePrefix = envMap.AIONIS_SCOPE_PREFIX ?? cfg.scopePrefix;

  if (!baseUrl || !apiKey) {
    throw new Error(`Missing AIONIS_BASE_URL or AIONIS_API_KEY in ${envPath}`);
  }

  const configPath = resolveOpenClawConfigPath();
  const root = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

  const obj = toRecord(root);
  const plugins = toRecord(obj.plugins);
  const entries = toRecord(plugins.entries);

  entries["openclaw-aionis-memory"] = {
    enabled: true,
    config: {
      baseUrl,
      apiKey,
      tenantId,
      scopeMode: cfg.scopeMode,
      scopePrefix,
      preset: cfg.preset,
      autoRecall: true,
      autoCapture: true,
      autoPolicyFeedback: true,
    },
  };

  plugins.entries = entries;
  obj.plugins = plugins;
  writeJsonWithBackup(configPath, obj);

  return { configPath, baseUrl, apiKey, tenantId, scopePrefix };
}

class AionisClient {
  constructor(
    private readonly cfg: AionisConfig,
    private readonly logger: OpenClawPluginApi["logger"],
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.cfg.apiKey,
      "x-tenant-id": this.cfg.tenantId,
      ...(extra ?? {}),
    };
  }

  private async post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const base = this.cfg.baseUrl.replace(/\/+$/g, "");
    const url = `${base}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err: AionisError = {
        status: res.status,
        code: String(json?.code ?? json?.error ?? `http_${res.status}`),
        message: String(json?.message ?? text ?? `Request failed: ${res.status}`),
        details: json?.details,
      };
      throw err;
    }

    return (json ?? {}) as T;
  }

  async health(): Promise<Record<string, unknown>> {
    const base = this.cfg.baseUrl.replace(/\/+$/g, "");
    const res = await fetch(`${base}/health`, { headers: this.headers() });
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async write(scope: string, inputText: string, metadata?: Record<string, unknown>): Promise<any> {
    return this.post("/v1/memory/write", {
      tenant_id: this.cfg.tenantId,
      scope,
      actor: this.cfg.actor,
      input_text: inputText,
      nodes: [],
      edges: [],
      ...(metadata ? { metadata } : {}),
    });
  }

  async recallText(scope: string, queryText: string, limit: number): Promise<any> {
    return this.post("/v1/memory/recall_text", {
      tenant_id: this.cfg.tenantId,
      scope,
      query_text: queryText,
      limit,
      context_char_budget: this.cfg.contextCharBudget,
      include_embeddings: false,
      include_meta: false,
      include_slots: false,
    });
  }

  async contextAssemble(
    scope: string,
    queryText: string,
    context: Record<string, unknown>,
    toolCandidates?: string[],
  ): Promise<any> {
    return this.post("/v1/memory/context/assemble", {
      tenant_id: this.cfg.tenantId,
      scope,
      query_text: queryText,
      context,
      include_rules: true,
      include_shadow: this.cfg.includeShadow,
      rules_limit: 50,
      ...(Array.isArray(toolCandidates) && toolCandidates.length > 0 ? { tool_candidates: toolCandidates } : {}),
      tool_strict: this.cfg.strictTools,
      limit: this.cfg.recallLimit,
      context_char_budget: this.cfg.contextCharBudget,
      return_layered_context: true,
    });
  }

  async toolsSelect(
    scope: string,
    runId: string,
    context: Record<string, unknown>,
    candidates: string[],
  ): Promise<ToolDecision> {
    return this.post<ToolDecision>("/v1/memory/tools/select", {
      tenant_id: this.cfg.tenantId,
      scope,
      run_id: runId,
      context,
      candidates,
      include_shadow: this.cfg.includeShadow,
      strict: this.cfg.strictTools,
      rules_limit: 50,
    });
  }

  async toolsFeedback(args: {
    scope: string;
    runId?: string;
    decisionId?: string;
    decisionUri?: string;
    context: Record<string, unknown>;
    candidates: string[];
    selectedTool: string;
    outcome: "positive" | "negative" | "neutral";
    note?: string;
    inputText: string;
  }): Promise<any> {
    return this.post("/v1/memory/tools/feedback", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      ...(args.runId ? { run_id: args.runId } : {}),
      ...(args.decisionId ? { decision_id: args.decisionId } : {}),
      ...(args.decisionUri ? { decision_uri: args.decisionUri } : {}),
      outcome: args.outcome,
      context: args.context,
      candidates: args.candidates,
      selected_tool: args.selectedTool,
      include_shadow: this.cfg.includeShadow,
      target: "tool",
      note: args.note,
      input_text: args.inputText,
    });
  }

  async replayRunStart(args: {
    scope: string;
    goal: string;
    runId?: string;
    contextSnapshotRef?: string;
    contextSnapshotHash?: string;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.post("/v1/memory/replay/run/start", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      goal: args.goal,
      ...(args.runId ? { run_id: args.runId } : {}),
      ...(args.contextSnapshotRef ? { context_snapshot_ref: args.contextSnapshotRef } : {}),
      ...(args.contextSnapshotHash ? { context_snapshot_hash: args.contextSnapshotHash } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayStepBefore(args: {
    scope: string;
    runId: string;
    stepIndex: number;
    toolName: string;
    toolInput: unknown;
    stepId?: string;
    decisionId?: string;
    expectedOutputSignature?: unknown;
    preconditions?: unknown[];
    retryPolicy?: Record<string, unknown>;
    safetyLevel?: ReplaySafetyLevel;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.post("/v1/memory/replay/step/before", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      run_id: args.runId,
      step_index: args.stepIndex,
      tool_name: args.toolName,
      tool_input: args.toolInput,
      ...(args.stepId ? { step_id: args.stepId } : {}),
      ...(args.decisionId ? { decision_id: args.decisionId } : {}),
      ...(args.expectedOutputSignature !== undefined ? { expected_output_signature: args.expectedOutputSignature } : {}),
      ...(Array.isArray(args.preconditions) ? { preconditions: args.preconditions } : {}),
      ...(args.retryPolicy ? { retry_policy: args.retryPolicy } : {}),
      ...(args.safetyLevel ? { safety_level: args.safetyLevel } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayStepAfter(args: {
    scope: string;
    runId: string;
    status: "success" | "failed" | "skipped" | "partial";
    stepId?: string;
    stepIndex?: number;
    outputSignature?: unknown;
    postconditions?: unknown[];
    artifactRefs?: string[];
    repairApplied?: boolean;
    repairNote?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.post("/v1/memory/replay/step/after", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      run_id: args.runId,
      status: args.status,
      ...(args.stepId ? { step_id: args.stepId } : {}),
      ...(Number.isFinite(args.stepIndex) ? { step_index: args.stepIndex } : {}),
      ...(args.outputSignature !== undefined ? { output_signature: args.outputSignature } : {}),
      ...(Array.isArray(args.postconditions) ? { postconditions: args.postconditions } : {}),
      ...(Array.isArray(args.artifactRefs) ? { artifact_refs: args.artifactRefs } : {}),
      ...(typeof args.repairApplied === "boolean" ? { repair_applied: args.repairApplied } : {}),
      ...(args.repairNote ? { repair_note: args.repairNote } : {}),
      ...(args.error ? { error: args.error } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayRunEnd(args: {
    scope: string;
    runId: string;
    status: "success" | "failed" | "partial";
    summary?: string;
    successCriteria?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.post("/v1/memory/replay/run/end", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      run_id: args.runId,
      status: args.status,
      ...(args.summary ? { summary: args.summary } : {}),
      ...(args.successCriteria ? { success_criteria: args.successCriteria } : {}),
      ...(args.metrics ? { metrics: args.metrics } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayRunGet(args: {
    scope: string;
    runId: string;
    includeSteps?: boolean;
    includeArtifacts?: boolean;
  }): Promise<any> {
    return this.post("/v1/memory/replay/runs/get", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      run_id: args.runId,
      ...(typeof args.includeSteps === "boolean" ? { include_steps: args.includeSteps } : {}),
      ...(typeof args.includeArtifacts === "boolean" ? { include_artifacts: args.includeArtifacts } : {}),
    });
  }

  async replayPlaybookCompileFromRun(args: {
    scope: string;
    runId: string;
    playbookId?: string;
    name?: string;
    version?: number;
    matchers?: Record<string, unknown>;
    successCriteria?: Record<string, unknown>;
    riskProfile?: "low" | "medium" | "high";
    allowPartial?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.post("/v1/memory/replay/playbooks/compile_from_run", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      run_id: args.runId,
      ...(args.playbookId ? { playbook_id: args.playbookId } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(Number.isFinite(args.version) ? { version: args.version } : {}),
      ...(args.matchers ? { matchers: args.matchers } : {}),
      ...(args.successCriteria ? { success_criteria: args.successCriteria } : {}),
      ...(args.riskProfile ? { risk_profile: args.riskProfile } : {}),
      ...(typeof args.allowPartial === "boolean" ? { allow_partial: args.allowPartial } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayPlaybookGet(args: { scope: string; playbookId: string }): Promise<any> {
    return this.post("/v1/memory/replay/playbooks/get", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      playbook_id: args.playbookId,
    });
  }

  async replayPlaybookPromote(args: {
    scope: string;
    playbookId: string;
    targetStatus: "draft" | "shadow" | "active" | "disabled";
    fromVersion?: number;
    note?: string;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.post("/v1/memory/replay/playbooks/promote", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      playbook_id: args.playbookId,
      target_status: args.targetStatus,
      ...(Number.isFinite(args.fromVersion) ? { from_version: args.fromVersion } : {}),
      ...(args.note ? { note: args.note } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayPlaybookRepair(args: {
    scope: string;
    playbookId: string;
    patch: Record<string, unknown>;
    fromVersion?: number;
    note?: string;
    reviewRequired?: boolean;
    targetStatus?: "draft" | "shadow" | "active" | "disabled";
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return this.post("/v1/memory/replay/playbooks/repair", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      playbook_id: args.playbookId,
      patch: args.patch,
      ...(Number.isFinite(args.fromVersion) ? { from_version: args.fromVersion } : {}),
      ...(args.note ? { note: args.note } : {}),
      ...(typeof args.reviewRequired === "boolean" ? { review_required: args.reviewRequired } : {}),
      ...(args.targetStatus ? { target_status: args.targetStatus } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayPlaybookRepairReview(args: {
    scope: string;
    playbookId: string;
    action: "approve" | "reject";
    version?: number;
    note?: string;
    autoShadowValidate?: boolean;
    shadowValidationMode?: "readiness" | "execute" | "execute_sandbox";
    shadowValidationMaxSteps?: number;
    shadowValidationParams?: Record<string, unknown>;
    targetStatusOnApprove?: "draft" | "shadow" | "active" | "disabled";
    autoPromoteOnPass?: boolean;
    autoPromoteTargetStatus?: "draft" | "shadow" | "active" | "disabled";
    autoPromoteGate?: Record<string, unknown>;
    shadowValidationProfile?: ReplayShadowValidationProfile;
    shadowValidationExecutionMode?: ReplayShadowValidationExecutionMode;
    shadowValidationTimeoutMs?: number;
    shadowValidationStopOnFailure?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    const mergedShadowValidationParams: Record<string, unknown> = {
      ...(args.shadowValidationParams ?? {}),
    };
    if (args.shadowValidationProfile) mergedShadowValidationParams.profile = args.shadowValidationProfile;
    if (args.shadowValidationExecutionMode) mergedShadowValidationParams.execution_mode = args.shadowValidationExecutionMode;
    if (Number.isFinite(args.shadowValidationTimeoutMs)) mergedShadowValidationParams.timeout_ms = args.shadowValidationTimeoutMs;
    if (typeof args.shadowValidationStopOnFailure === "boolean") mergedShadowValidationParams.stop_on_failure = args.shadowValidationStopOnFailure;

    return this.post("/v1/memory/replay/playbooks/repair/review", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      playbook_id: args.playbookId,
      action: args.action,
      ...(Number.isFinite(args.version) ? { version: args.version } : {}),
      ...(args.note ? { note: args.note } : {}),
      ...(typeof args.autoShadowValidate === "boolean" ? { auto_shadow_validate: args.autoShadowValidate } : {}),
      ...(args.shadowValidationMode ? { shadow_validation_mode: args.shadowValidationMode } : {}),
      ...(Number.isFinite(args.shadowValidationMaxSteps) ? { shadow_validation_max_steps: args.shadowValidationMaxSteps } : {}),
      ...(Object.keys(mergedShadowValidationParams).length > 0 ? { shadow_validation_params: mergedShadowValidationParams } : {}),
      ...(args.targetStatusOnApprove ? { target_status_on_approve: args.targetStatusOnApprove } : {}),
      ...(typeof args.autoPromoteOnPass === "boolean" ? { auto_promote_on_pass: args.autoPromoteOnPass } : {}),
      ...(args.autoPromoteTargetStatus ? { auto_promote_target_status: args.autoPromoteTargetStatus } : {}),
      ...(args.autoPromoteGate ? { auto_promote_gate: args.autoPromoteGate } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }

  async replayPlaybookRun(args: {
    scope: string;
    playbookId: string;
    mode: ReplayRunMode;
    version?: number;
    projectId?: string;
    executionBackend?: ReplayExecutionBackend;
    sensitiveReviewMode?: ReplaySensitiveReviewMode;
    allowSensitiveExec?: boolean;
    allowLocalExec?: boolean;
    guidedRepairStrategy?: ReplayGuidedRepairStrategy;
    commandAliasMap?: Record<string, unknown>;
    guidedRepairMaxErrorChars?: number;
    params?: Record<string, unknown>;
    maxSteps?: number;
  }): Promise<any> {
    const mergedParams: Record<string, unknown> = {
      ...(args.params ?? {}),
    };
    if (args.projectId) mergedParams.project_id = args.projectId;
    if (args.executionBackend) mergedParams.execution_backend = args.executionBackend;
    if (args.sensitiveReviewMode) mergedParams.sensitive_review_mode = args.sensitiveReviewMode;
    if (typeof args.allowSensitiveExec === "boolean") mergedParams.allow_sensitive_exec = args.allowSensitiveExec;
    if (typeof args.allowLocalExec === "boolean") mergedParams.allow_local_exec = args.allowLocalExec;
    if (args.guidedRepairStrategy) mergedParams.guided_repair_strategy = args.guidedRepairStrategy;
    if (args.commandAliasMap) mergedParams.command_alias_map = args.commandAliasMap;
    if (Number.isFinite(args.guidedRepairMaxErrorChars)) mergedParams.guided_repair_max_error_chars = args.guidedRepairMaxErrorChars;

    return this.post("/v1/memory/replay/playbooks/run", {
      tenant_id: this.cfg.tenantId,
      scope: args.scope,
      actor: this.cfg.actor,
      playbook_id: args.playbookId,
      mode: args.mode,
      ...(Number.isFinite(args.version) ? { version: args.version } : {}),
      ...(args.projectId ? { project_id: args.projectId } : {}),
      ...(Object.keys(mergedParams).length > 0 ? { params: mergedParams } : {}),
      ...(Number.isFinite(args.maxSteps) ? { max_steps: args.maxSteps } : {}),
    });
  }
}

const plugin = {
  id: "openclaw-aionis-memory",
  name: "Memory (Aionis)",
  description: "Aionis-powered memory plugin for OpenClaw with auto-recall and auto-capture.",
  kind: "memory" as const,
  configSchema: Type.Object({
    baseUrl: Type.Optional(Type.String()),
    apiKey: Type.Optional(Type.String()),
    tenantId: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    scopePrefix: Type.Optional(Type.String()),
    scopeMode: Type.Optional(Type.Union([Type.Literal("fixed"), Type.Literal("session"), Type.Literal("project")])),
    userId: Type.Optional(Type.String()),
    actor: Type.Optional(Type.String()),
    preset: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("policy-first"), Type.Literal("custom")])),
    autoRecall: Type.Optional(Type.Boolean()),
    autoCapture: Type.Optional(Type.Boolean()),
    autoPolicyFeedback: Type.Optional(Type.Boolean()),
    includeShadow: Type.Optional(Type.Boolean()),
    strictTools: Type.Optional(Type.Boolean()),
    recallLimit: Type.Optional(Type.Number()),
    captureMessageLimit: Type.Optional(Type.Number()),
    contextCharBudget: Type.Optional(Type.Number()),
    debug: Type.Optional(Type.Boolean()),
  }),

  register(api: OpenClawPluginApi) {
    const rawCfg = toRecord(api.pluginConfig);
    const parsed = ConfigSchema.parse(rawCfg) as AionisConfig;
    const resolved = applyPreset(rawCfg, parsed);

    if (!resolved.apiKey) {
      api.logger.warn("openclaw-aionis-memory: apiKey missing. Set plugin config apiKey or env AIONIS_API_KEY.");
    }

    const client = new AionisClient(resolved, api.logger);
    const lastDecisionBySession = new Map<string, { decisionId?: string; decisionUri?: string; candidates: string[]; selected?: string }>();

    api.logger.info(
      `openclaw-aionis-memory: registered (base=${resolved.baseUrl}, tenant=${resolved.tenantId}, scopeMode=${resolved.scopeMode}, preset=${resolved.preset}, autoRecall=${resolved.autoRecall}, autoCapture=${resolved.autoCapture}, autoPolicyFeedback=${resolved.autoPolicyFeedback})`,
    );

    api.registerTool(
      {
        name: "aionis_memory_search",
        label: "Aionis Memory Search",
        description: "Search relevant memory snippets from Aionis recall_text endpoint.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language query" }),
          limit: Type.Optional(Type.Number({ description: "Result limit (default plugin setting)" })),
          scope: Type.Optional(Type.String({ description: "Optional explicit scope override" })),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const query = String(p.query ?? "").trim();
            if (!query) return toToolText("query is required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const limit = Number.isFinite(p.limit as number) ? Number(p.limit) : resolved.recallLimit;
            const out = await client.recallText(scope, query, Math.max(1, Math.min(50, limit)));
            const text = String(out?.context?.text ?? "").trim() || "No relevant memory found.";
            return toToolText(text, out);
          } catch (err) {
            return toToolText(`aionis_memory_search failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_memory_search" },
    );

    api.registerTool(
      {
        name: "aionis_memory_store",
        label: "Aionis Memory Store",
        description: "Persist a memory write into Aionis.",
        parameters: Type.Object({
          text: Type.String({ description: "Text to store as memory" }),
          scope: Type.Optional(Type.String({ description: "Optional explicit scope override" })),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const text = String(p.text ?? "").trim();
            if (!text) return toToolText("text is required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.write(scope, cleanText(text, 4000));
            return toToolText(`Stored memory (commit_id=${String(out?.commit_id ?? "n/a")})`, out);
          } catch (err) {
            return toToolText(`aionis_memory_store failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_memory_store" },
    );

    api.registerTool(
      {
        name: "aionis_memory_context",
        label: "Aionis Context Assemble",
        description: "Assemble layered context from Aionis memory and policy services.",
        parameters: Type.Object({
          query: Type.String({ description: "Query text" }),
          candidates: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          runId: Type.Optional(Type.String()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const query = String(p.query ?? "").trim();
            if (!query) return toToolText("query is required", { ok: false });
            const runId = typeof p.runId === "string" ? p.runId : undefined;
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const candidates = Array.isArray(p.candidates)
              ? p.candidates.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
              : undefined;
            const context = {
              source: "openclaw-tool",
              user_id: resolved.userId,
              run_id: runId,
            };
            const out = await client.contextAssemble(scope, query, context, candidates);
            const text = summarizeContextAsText(out);
            return toToolText(text || "Context assembled.", out);
          } catch (err) {
            return toToolText(`aionis_memory_context failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_memory_context" },
    );

    api.registerTool(
      {
        name: "aionis_policy_select",
        label: "Aionis Policy Select",
        description: "Select a tool with Aionis policy loop (tools/select).",
        parameters: Type.Object({
          runId: Type.String(),
          candidates: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          context: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const runId = String(p.runId ?? "").trim();
            const candidates = Array.isArray(p.candidates)
              ? p.candidates.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
              : [];
            if (!runId || candidates.length === 0) {
              return toToolText("runId and non-empty candidates are required", { ok: false });
            }
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const context = toRecord(p.context);
            const out = await client.toolsSelect(scope, runId, context, candidates);
            return toToolText(`Selected tool: ${String(out.selected_tool ?? out.selected ?? "n/a")}`, out);
          } catch (err) {
            return toToolText(`aionis_policy_select failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_policy_select" },
    );

    api.registerTool(
      {
        name: "aionis_policy_feedback",
        label: "Aionis Policy Feedback",
        description: "Write tool outcome feedback into Aionis policy loop (tools/feedback).",
        parameters: Type.Object({
          runId: Type.Optional(Type.String()),
          decisionId: Type.Optional(Type.String()),
          decisionUri: Type.Optional(Type.String()),
          candidates: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          selectedTool: Type.String({ minLength: 1 }),
          outcome: Type.Union([Type.Literal("positive"), Type.Literal("negative"), Type.Literal("neutral")]),
          context: Type.Optional(Type.Any()),
          note: Type.Optional(Type.String()),
          inputText: Type.String({ minLength: 1 }),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const candidates = Array.isArray(p.candidates)
              ? p.candidates.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
              : [];
            if (candidates.length === 0) return toToolText("candidates are required", { ok: false });
            const selectedTool = String(p.selectedTool ?? "").trim();
            const inputText = String(p.inputText ?? "").trim();
            if (!selectedTool || !inputText) return toToolText("selectedTool and inputText are required", { ok: false });
            const outcomeRaw = String(p.outcome ?? "neutral");
            const outcome = outcomeRaw === "positive" || outcomeRaw === "negative" || outcomeRaw === "neutral" ? outcomeRaw : "neutral";
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.toolsFeedback({
              scope,
              runId: typeof p.runId === "string" ? p.runId : undefined,
              decisionId: typeof p.decisionId === "string" ? p.decisionId : undefined,
              decisionUri: typeof p.decisionUri === "string" ? p.decisionUri : undefined,
              context: toRecord(p.context),
              candidates,
              selectedTool,
              outcome,
              note: typeof p.note === "string" ? p.note : undefined,
              inputText,
            });
            return toToolText("Policy feedback stored.", out);
          } catch (err) {
            return toToolText(`aionis_policy_feedback failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_policy_feedback" },
    );

    api.registerTool(
      {
        name: "aionis_replay_run_start",
        label: "Aionis Replay Run Start",
        description: "Start a replay run envelope.",
        parameters: Type.Object({
          goal: Type.String({ minLength: 1 }),
          runId: Type.Optional(Type.String({ minLength: 1 })),
          contextSnapshotRef: Type.Optional(Type.String({ minLength: 1 })),
          contextSnapshotHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const goal = String(p.goal ?? "").trim();
            if (!goal) return toToolText("goal is required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayRunStart({
              scope,
              goal,
              runId: typeof p.runId === "string" && p.runId.trim() ? p.runId.trim() : undefined,
              contextSnapshotRef: typeof p.contextSnapshotRef === "string" && p.contextSnapshotRef.trim()
                ? p.contextSnapshotRef.trim()
                : undefined,
              contextSnapshotHash: typeof p.contextSnapshotHash === "string" && p.contextSnapshotHash.trim()
                ? p.contextSnapshotHash.trim()
                : undefined,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText(`Replay run started (run_id=${String(out?.run_id ?? out?.run?.run_id ?? "n/a")})`, out);
          } catch (err) {
            return toToolText(`aionis_replay_run_start failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_run_start" },
    );

    api.registerTool(
      {
        name: "aionis_replay_step_before",
        label: "Aionis Replay Step Before",
        description: "Record one replay step before execution.",
        parameters: Type.Object({
          runId: Type.String({ minLength: 1 }),
          stepIndex: Type.Number({ minimum: 1 }),
          toolName: Type.String({ minLength: 1 }),
          toolInput: Type.Any(),
          stepId: Type.Optional(Type.String({ minLength: 1 })),
          decisionId: Type.Optional(Type.String({ minLength: 1 })),
          expectedOutputSignature: Type.Optional(Type.Any()),
          preconditions: Type.Optional(Type.Array(Type.Any())),
          retryPolicy: Type.Optional(Type.Any()),
          safetyLevel: Type.Optional(Type.Union([Type.Literal("auto_ok"), Type.Literal("needs_confirm"), Type.Literal("manual_only")])),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const runId = String(p.runId ?? "").trim();
            const toolName = String(p.toolName ?? "").trim();
            const stepIndex = Number(p.stepIndex ?? 0);
            if (!runId || !toolName || !Number.isInteger(stepIndex) || stepIndex <= 0) {
              return toToolText("runId, toolName, and positive integer stepIndex are required", { ok: false });
            }
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const safetyRaw = String(p.safetyLevel ?? "");
            const safetyLevel: ReplaySafetyLevel | undefined = safetyRaw === "auto_ok" || safetyRaw === "needs_confirm" || safetyRaw === "manual_only"
              ? (safetyRaw as ReplaySafetyLevel)
              : undefined;
            const out = await client.replayStepBefore({
              scope,
              runId,
              stepIndex,
              toolName,
              toolInput: p.toolInput ?? {},
              stepId: typeof p.stepId === "string" && p.stepId.trim() ? p.stepId.trim() : undefined,
              decisionId: typeof p.decisionId === "string" && p.decisionId.trim() ? p.decisionId.trim() : undefined,
              expectedOutputSignature: p.expectedOutputSignature,
              preconditions: Array.isArray(p.preconditions) ? p.preconditions : undefined,
              retryPolicy: p.retryPolicy && typeof p.retryPolicy === "object" && !Array.isArray(p.retryPolicy)
                ? (p.retryPolicy as Record<string, unknown>)
                : undefined,
              safetyLevel,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText("Replay step(before) stored.", out);
          } catch (err) {
            return toToolText(`aionis_replay_step_before failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_step_before" },
    );

    api.registerTool(
      {
        name: "aionis_replay_step_after",
        label: "Aionis Replay Step After",
        description: "Record one replay step result after execution.",
        parameters: Type.Object({
          runId: Type.String({ minLength: 1 }),
          status: Type.Union([Type.Literal("success"), Type.Literal("failed"), Type.Literal("skipped"), Type.Literal("partial")]),
          stepId: Type.Optional(Type.String({ minLength: 1 })),
          stepIndex: Type.Optional(Type.Number({ minimum: 1 })),
          outputSignature: Type.Optional(Type.Any()),
          postconditions: Type.Optional(Type.Array(Type.Any())),
          artifactRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          repairApplied: Type.Optional(Type.Boolean()),
          repairNote: Type.Optional(Type.String({ minLength: 1 })),
          error: Type.Optional(Type.String({ minLength: 1 })),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const runId = String(p.runId ?? "").trim();
            const statusRaw = String(p.status ?? "");
            const status = statusRaw === "success" || statusRaw === "failed" || statusRaw === "skipped" || statusRaw === "partial"
              ? statusRaw
              : "";
            if (!runId || !status) return toToolText("runId and valid status are required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayStepAfter({
              scope,
              runId,
              status,
              stepId: typeof p.stepId === "string" && p.stepId.trim() ? p.stepId.trim() : undefined,
              stepIndex: Number.isInteger(p.stepIndex as number) ? Number(p.stepIndex) : undefined,
              outputSignature: p.outputSignature,
              postconditions: Array.isArray(p.postconditions) ? p.postconditions : undefined,
              artifactRefs: Array.isArray(p.artifactRefs)
                ? p.artifactRefs.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
                : undefined,
              repairApplied: typeof p.repairApplied === "boolean" ? p.repairApplied : undefined,
              repairNote: typeof p.repairNote === "string" && p.repairNote.trim() ? p.repairNote.trim() : undefined,
              error: typeof p.error === "string" && p.error.trim() ? p.error.trim() : undefined,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText("Replay step(after) stored.", out);
          } catch (err) {
            return toToolText(`aionis_replay_step_after failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_step_after" },
    );

    api.registerTool(
      {
        name: "aionis_replay_run_end",
        label: "Aionis Replay Run End",
        description: "Close replay run with final status and summary.",
        parameters: Type.Object({
          runId: Type.String({ minLength: 1 }),
          status: Type.Union([Type.Literal("success"), Type.Literal("failed"), Type.Literal("partial")]),
          summary: Type.Optional(Type.String({ minLength: 1 })),
          successCriteria: Type.Optional(Type.Any()),
          metrics: Type.Optional(Type.Any()),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const runId = String(p.runId ?? "").trim();
            const statusRaw = String(p.status ?? "");
            const status = statusRaw === "success" || statusRaw === "failed" || statusRaw === "partial" ? statusRaw : "";
            if (!runId || !status) return toToolText("runId and valid status are required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayRunEnd({
              scope,
              runId,
              status,
              summary: typeof p.summary === "string" && p.summary.trim() ? p.summary.trim() : undefined,
              successCriteria: p.successCriteria && typeof p.successCriteria === "object" && !Array.isArray(p.successCriteria)
                ? (p.successCriteria as Record<string, unknown>)
                : undefined,
              metrics: p.metrics && typeof p.metrics === "object" && !Array.isArray(p.metrics)
                ? (p.metrics as Record<string, unknown>)
                : undefined,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText("Replay run closed.", out);
          } catch (err) {
            return toToolText(`aionis_replay_run_end failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_run_end" },
    );

    api.registerTool(
      {
        name: "aionis_replay_run_get",
        label: "Aionis Replay Run Get",
        description: "Read one replay run timeline and artifacts.",
        parameters: Type.Object({
          runId: Type.String({ minLength: 1 }),
          includeSteps: Type.Optional(Type.Boolean()),
          includeArtifacts: Type.Optional(Type.Boolean()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const runId = String(p.runId ?? "").trim();
            if (!runId) return toToolText("runId is required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayRunGet({
              scope,
              runId,
              includeSteps: typeof p.includeSteps === "boolean" ? p.includeSteps : undefined,
              includeArtifacts: typeof p.includeArtifacts === "boolean" ? p.includeArtifacts : undefined,
            });
            return toToolText(`Replay run fetched (run_id=${runId})`, out);
          } catch (err) {
            return toToolText(`aionis_replay_run_get failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_run_get" },
    );

    api.registerTool(
      {
        name: "aionis_replay_playbook_compile",
        label: "Aionis Replay Playbook Compile",
        description: "Compile replay playbook from one completed run.",
        parameters: Type.Object({
          runId: Type.String({ minLength: 1 }),
          playbookId: Type.Optional(Type.String({ minLength: 1 })),
          name: Type.Optional(Type.String({ minLength: 1 })),
          version: Type.Optional(Type.Number({ minimum: 1 })),
          matchers: Type.Optional(Type.Any()),
          successCriteria: Type.Optional(Type.Any()),
          riskProfile: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
          allowPartial: Type.Optional(Type.Boolean()),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const runId = String(p.runId ?? "").trim();
            if (!runId) return toToolText("runId is required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const riskRaw = String(p.riskProfile ?? "");
            const riskProfile = riskRaw === "low" || riskRaw === "medium" || riskRaw === "high" ? riskRaw : undefined;
            const out = await client.replayPlaybookCompileFromRun({
              scope,
              runId,
              playbookId: typeof p.playbookId === "string" && p.playbookId.trim() ? p.playbookId.trim() : undefined,
              name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined,
              version: Number.isInteger(p.version as number) ? Number(p.version) : undefined,
              matchers: p.matchers && typeof p.matchers === "object" && !Array.isArray(p.matchers)
                ? (p.matchers as Record<string, unknown>)
                : undefined,
              successCriteria: p.successCriteria && typeof p.successCriteria === "object" && !Array.isArray(p.successCriteria)
                ? (p.successCriteria as Record<string, unknown>)
                : undefined,
              riskProfile,
              allowPartial: typeof p.allowPartial === "boolean" ? p.allowPartial : undefined,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText(`Replay playbook compiled (playbook_id=${String(out?.playbook_id ?? out?.playbook?.playbook_id ?? "n/a")})`, out);
          } catch (err) {
            return toToolText(`aionis_replay_playbook_compile failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_playbook_compile" },
    );

    api.registerTool(
      {
        name: "aionis_replay_playbook_get",
        label: "Aionis Replay Playbook Get",
        description: "Read replay playbook by id.",
        parameters: Type.Object({
          playbookId: Type.String({ minLength: 1 }),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const playbookId = String(p.playbookId ?? "").trim();
            if (!playbookId) return toToolText("playbookId is required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayPlaybookGet({ scope, playbookId });
            return toToolText(`Replay playbook fetched (playbook_id=${playbookId})`, out);
          } catch (err) {
            return toToolText(`aionis_replay_playbook_get failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_playbook_get" },
    );

    api.registerTool(
      {
        name: "aionis_replay_playbook_promote",
        label: "Aionis Replay Playbook Promote",
        description: "Promote replay playbook lifecycle status.",
        parameters: Type.Object({
          playbookId: Type.String({ minLength: 1 }),
          targetStatus: Type.Union([Type.Literal("draft"), Type.Literal("shadow"), Type.Literal("active"), Type.Literal("disabled")]),
          fromVersion: Type.Optional(Type.Number({ minimum: 1 })),
          note: Type.Optional(Type.String({ minLength: 1 })),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const playbookId = String(p.playbookId ?? "").trim();
            const targetRaw = String(p.targetStatus ?? "");
            const targetStatus = targetRaw === "draft" || targetRaw === "shadow" || targetRaw === "active" || targetRaw === "disabled"
              ? targetRaw
              : "";
            if (!playbookId || !targetStatus) return toToolText("playbookId and valid targetStatus are required", { ok: false });
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayPlaybookPromote({
              scope,
              playbookId,
              targetStatus,
              fromVersion: Number.isInteger(p.fromVersion as number) ? Number(p.fromVersion) : undefined,
              note: typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText("Replay playbook promoted.", out);
          } catch (err) {
            return toToolText(`aionis_replay_playbook_promote failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_playbook_promote" },
    );

    api.registerTool(
      {
        name: "aionis_replay_playbook_repair",
        label: "Aionis Replay Playbook Repair",
        description: "Apply repair patch and emit a new replay playbook version.",
        parameters: Type.Object({
          playbookId: Type.String({ minLength: 1 }),
          patch: Type.Any(),
          fromVersion: Type.Optional(Type.Number({ minimum: 1 })),
          note: Type.Optional(Type.String({ minLength: 1 })),
          reviewRequired: Type.Optional(Type.Boolean()),
          targetStatus: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("shadow"), Type.Literal("active"), Type.Literal("disabled")])),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const playbookId = String(p.playbookId ?? "").trim();
            if (!playbookId) return toToolText("playbookId is required", { ok: false });
            if (!p.patch || typeof p.patch !== "object" || Array.isArray(p.patch)) {
              return toToolText("patch object is required", { ok: false });
            }
            const targetRaw = String(p.targetStatus ?? "");
            const targetStatus = targetRaw === "draft" || targetRaw === "shadow" || targetRaw === "active" || targetRaw === "disabled"
              ? targetRaw
              : undefined;
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayPlaybookRepair({
              scope,
              playbookId,
              patch: p.patch as Record<string, unknown>,
              fromVersion: Number.isInteger(p.fromVersion as number) ? Number(p.fromVersion) : undefined,
              note: typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined,
              reviewRequired: typeof p.reviewRequired === "boolean" ? p.reviewRequired : undefined,
              targetStatus,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText("Replay playbook repair patch submitted.", out);
          } catch (err) {
            return toToolText(`aionis_replay_playbook_repair failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_playbook_repair" },
    );

    api.registerTool(
      {
        name: "aionis_replay_playbook_repair_review",
        label: "Aionis Replay Playbook Repair Review",
        description: "Review repaired replay playbook version and optional shadow validation.",
        parameters: Type.Object({
          playbookId: Type.String({ minLength: 1 }),
          action: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
          version: Type.Optional(Type.Number({ minimum: 1 })),
          note: Type.Optional(Type.String({ minLength: 1 })),
          autoShadowValidate: Type.Optional(Type.Boolean()),
          shadowValidationMode: Type.Optional(Type.Union([Type.Literal("readiness"), Type.Literal("execute"), Type.Literal("execute_sandbox")])),
          shadowValidationMaxSteps: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
          shadowValidationProfile: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("thorough")])),
          shadowValidationExecutionMode: Type.Optional(Type.Union([Type.Literal("sync"), Type.Literal("async_queue")])),
          shadowValidationTimeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 600000 })),
          shadowValidationStopOnFailure: Type.Optional(Type.Boolean()),
          shadowValidationParams: Type.Optional(Type.Any()),
          targetStatusOnApprove: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("shadow"), Type.Literal("active"), Type.Literal("disabled")])),
          autoPromoteOnPass: Type.Optional(Type.Boolean()),
          autoPromoteTargetStatus: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("shadow"), Type.Literal("active"), Type.Literal("disabled")])),
          autoPromoteGate: Type.Optional(Type.Any()),
          metadata: Type.Optional(Type.Any()),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const playbookId = String(p.playbookId ?? "").trim();
            const actionRaw = String(p.action ?? "");
            const action = actionRaw === "approve" || actionRaw === "reject" ? actionRaw : "";
            if (!playbookId || !action) return toToolText("playbookId and action are required", { ok: false });
            const modeRaw = String(p.shadowValidationMode ?? "");
            const shadowValidationMode = modeRaw === "readiness" || modeRaw === "execute" || modeRaw === "execute_sandbox"
              ? modeRaw
              : undefined;
            const profileRaw = String(p.shadowValidationProfile ?? "");
            const shadowValidationProfile = profileRaw === "fast" || profileRaw === "balanced" || profileRaw === "thorough"
              ? profileRaw
              : undefined;
            const execModeRaw = String(p.shadowValidationExecutionMode ?? "");
            const shadowValidationExecutionMode = execModeRaw === "sync" || execModeRaw === "async_queue"
              ? execModeRaw
              : undefined;
            const targetRaw = String(p.targetStatusOnApprove ?? "");
            const targetStatusOnApprove = targetRaw === "draft" || targetRaw === "shadow" || targetRaw === "active" || targetRaw === "disabled"
              ? targetRaw
              : undefined;
            const promoteRaw = String(p.autoPromoteTargetStatus ?? "");
            const autoPromoteTargetStatus = promoteRaw === "draft" || promoteRaw === "shadow" || promoteRaw === "active" || promoteRaw === "disabled"
              ? promoteRaw
              : undefined;
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayPlaybookRepairReview({
              scope,
              playbookId,
              action,
              version: Number.isInteger(p.version as number) ? Number(p.version) : undefined,
              note: typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined,
              autoShadowValidate: typeof p.autoShadowValidate === "boolean" ? p.autoShadowValidate : undefined,
              shadowValidationMode,
              shadowValidationMaxSteps: Number.isInteger(p.shadowValidationMaxSteps as number) ? Number(p.shadowValidationMaxSteps) : undefined,
              shadowValidationProfile,
              shadowValidationExecutionMode,
              shadowValidationTimeoutMs: Number.isInteger(p.shadowValidationTimeoutMs as number) ? Number(p.shadowValidationTimeoutMs) : undefined,
              shadowValidationStopOnFailure: typeof p.shadowValidationStopOnFailure === "boolean" ? p.shadowValidationStopOnFailure : undefined,
              shadowValidationParams: p.shadowValidationParams && typeof p.shadowValidationParams === "object" && !Array.isArray(p.shadowValidationParams)
                ? (p.shadowValidationParams as Record<string, unknown>)
                : undefined,
              targetStatusOnApprove,
              autoPromoteOnPass: typeof p.autoPromoteOnPass === "boolean" ? p.autoPromoteOnPass : undefined,
              autoPromoteTargetStatus,
              autoPromoteGate: p.autoPromoteGate && typeof p.autoPromoteGate === "object" && !Array.isArray(p.autoPromoteGate)
                ? (p.autoPromoteGate as Record<string, unknown>)
                : undefined,
              metadata: p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
                ? (p.metadata as Record<string, unknown>)
                : undefined,
            });
            return toToolText("Replay playbook repair review submitted.", out);
          } catch (err) {
            return toToolText(`aionis_replay_playbook_repair_review failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_playbook_repair_review" },
    );

    api.registerTool(
      {
        name: "aionis_replay_playbook_run",
        label: "Aionis Replay Playbook Run",
        description: "Run replay playbook in simulate/strict/guided mode.",
        parameters: Type.Object({
          playbookId: Type.String({ minLength: 1 }),
          mode: Type.Optional(Type.Union([Type.Literal("simulate"), Type.Literal("strict"), Type.Literal("guided")])),
          version: Type.Optional(Type.Number({ minimum: 1 })),
          projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          executionBackend: Type.Optional(Type.Union([Type.Literal("local_process"), Type.Literal("sandbox_sync"), Type.Literal("sandbox_async")])),
          sensitiveReviewMode: Type.Optional(Type.Union([Type.Literal("block"), Type.Literal("warn")])),
          allowSensitiveExec: Type.Optional(Type.Boolean()),
          allowLocalExec: Type.Optional(Type.Boolean()),
          guidedRepairStrategy: Type.Optional(Type.Union([Type.Literal("deterministic_skip"), Type.Literal("heuristic_patch"), Type.Literal("http_synth"), Type.Literal("builtin_llm")])),
          commandAliasMap: Type.Optional(Type.Any()),
          guidedRepairMaxErrorChars: Type.Optional(Type.Number({ minimum: 1, maximum: 20000 })),
          params: Type.Optional(Type.Any()),
          maxSteps: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
          scope: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: unknown) {
          try {
            const p = toRecord(params);
            const playbookId = String(p.playbookId ?? "").trim();
            if (!playbookId) return toToolText("playbookId is required", { ok: false });
            const modeRaw = String(p.mode ?? "simulate");
            const mode: ReplayRunMode = modeRaw === "strict" || modeRaw === "guided" || modeRaw === "simulate" ? modeRaw : "simulate";
            const backendRaw = String(p.executionBackend ?? "");
            const executionBackend: ReplayExecutionBackend | undefined = backendRaw === "local_process" || backendRaw === "sandbox_sync" || backendRaw === "sandbox_async"
              ? backendRaw
              : undefined;
            const sensitiveReviewRaw = String(p.sensitiveReviewMode ?? "");
            const sensitiveReviewMode: ReplaySensitiveReviewMode | undefined = sensitiveReviewRaw === "block" || sensitiveReviewRaw === "warn"
              ? sensitiveReviewRaw
              : undefined;
            const strategyRaw = String(p.guidedRepairStrategy ?? "");
            const guidedRepairStrategy: ReplayGuidedRepairStrategy | undefined =
              strategyRaw === "deterministic_skip" || strategyRaw === "heuristic_patch" || strategyRaw === "http_synth" || strategyRaw === "builtin_llm"
                ? strategyRaw
                : undefined;
            const projectId = typeof p.projectId === "string" && p.projectId.trim() ? p.projectId.trim() : undefined;
            const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
            const out = await client.replayPlaybookRun({
              scope,
              playbookId,
              mode,
              version: Number.isInteger(p.version as number) ? Number(p.version) : undefined,
              projectId,
              executionBackend,
              sensitiveReviewMode,
              allowSensitiveExec: typeof p.allowSensitiveExec === "boolean" ? p.allowSensitiveExec : undefined,
              allowLocalExec: typeof p.allowLocalExec === "boolean" ? p.allowLocalExec : undefined,
              guidedRepairStrategy,
              commandAliasMap: p.commandAliasMap && typeof p.commandAliasMap === "object" && !Array.isArray(p.commandAliasMap)
                ? (p.commandAliasMap as Record<string, unknown>)
                : undefined,
              guidedRepairMaxErrorChars: Number.isInteger(p.guidedRepairMaxErrorChars as number) ? Number(p.guidedRepairMaxErrorChars) : undefined,
              params: p.params && typeof p.params === "object" && !Array.isArray(p.params)
                ? (p.params as Record<string, unknown>)
                : undefined,
              maxSteps: Number.isInteger(p.maxSteps as number) ? Number(p.maxSteps) : undefined,
            });
            return toToolText(`Replay playbook executed (mode=${mode}).`, out);
          } catch (err) {
            return toToolText(`aionis_replay_playbook_run failed: ${formatError(err)}`, { ok: false, error: err });
          }
        },
      },
      { name: "aionis_replay_playbook_run" },
    );

    if (typeof api.registerCli === "function") {
      api.registerCli(
        ({ program }) => {
          const root = program.command("aionis-memory").description("Aionis memory helper commands");

          root
            .command("bootstrap")
            .description("Bootstrap local Aionis standalone and auto-write plugin config")
            .option("--port <port>", "Aionis local port")
            .option("--container <name>", "Docker container name")
            .option("--volume <name>", "Docker data volume name")
            .option("--skip-health", "Skip health probe after bootstrap", false)
            .action(async (opts: { port?: string; container?: string; volume?: string; skipHealth?: boolean }) => {
              try {
                const scriptPath = fileURLToPath(new URL("../bootstrap-local-standalone.sh", import.meta.url));
                const env = { ...process.env } as NodeJS.ProcessEnv;
                if (opts.port?.trim()) env.AIONIS_PORT = opts.port.trim();
                if (opts.container?.trim()) env.AIONIS_CONTAINER_NAME = opts.container.trim();
                if (opts.volume?.trim()) env.AIONIS_DATA_VOLUME = opts.volume.trim();

                const child = spawnSync("bash", [scriptPath], {
                  stdio: "inherit",
                  env,
                });

                if ((child.status ?? 1) !== 0) {
                  throw new Error(`bootstrap script exited with status ${String(child.status ?? 1)}`);
                }

                const written = autoWritePluginConfigFromClawbotEnv(resolved);
                api.logger.info(`openclaw-aionis-memory: wrote plugin config to ${written.configPath}`);

                if (!opts.skipHealth) {
                  const probeCfg: AionisConfig = {
                    ...resolved,
                    baseUrl: written.baseUrl,
                    apiKey: written.apiKey,
                    tenantId: written.tenantId,
                    scopePrefix: written.scopePrefix,
                  };
                  const probeClient = new AionisClient(probeCfg, api.logger);
                  await probeClient.health();
                  api.logger.info(`openclaw-aionis-memory: bootstrap health check passed at ${written.baseUrl}/health`);
                }

                console.log("Bootstrap complete.");
                console.log("Next: openclaw aionis-memory selfcheck --scope clawbot:selfcheck");
              } catch (err) {
                console.error(`bootstrap failed: ${formatError(err)}`);
              }
            });

          root
            .command("health")
            .description("Check Aionis health")
            .action(async () => {
              try {
                const out = await client.health();
                console.log(JSON.stringify(out, null, 2));
              } catch (err) {
                console.error(`health failed: ${formatError(err)}`);
              }
            });

          root
            .command("selfcheck")
            .description("Run quick write + context + policy path check")
            .option("--scope <scope>", "scope override")
            .action(async (opts: { scope?: string }) => {
              const scope = opts.scope?.trim() || resolved.scope;
              const runId = `selfcheck_${Date.now()}`;
              try {
                const write = await client.write(scope, `Aionis selfcheck at ${new Date().toISOString()}`);
                const context = await client.contextAssemble(
                  scope,
                  "selfcheck memory context",
                  { source: "openclaw-cli", run_id: runId },
                  ["send_email", "create_ticket"],
                );
                const select = await client.toolsSelect(scope, runId, { source: "openclaw-cli" }, ["send_email", "create_ticket"]);
                const selected = String(select.selected_tool ?? select.selected ?? "send_email");
                const feedback = await client.toolsFeedback({
                  scope,
                  runId,
                  decisionId: select.decision_id,
                  decisionUri: select.decision_uri,
                  context: { source: "openclaw-cli" },
                  candidates: ["send_email", "create_ticket"],
                  selectedTool: selected,
                  outcome: "positive",
                  inputText: "selfcheck feedback",
                });
                console.log(
                  JSON.stringify(
                    {
                      overall_status: "pass",
                      scope,
                      run_id: runId,
                      write_commit_id: write?.commit_id,
                      selected_tool: select.selected_tool ?? select.selected,
                      decision_id: select.decision_id,
                      context_mode: context?.layered_context?.mode ?? null,
                      feedback_ok: !!feedback,
                    },
                    null,
                    2,
                  ),
                );
              } catch (err) {
                console.error(
                  JSON.stringify(
                    {
                      overall_status: "fail",
                      scope,
                      run_id: runId,
                      error: formatError(err),
                    },
                    null,
                    2,
                  ),
                );
              }
            });

          root
            .command("replay-selfcheck")
            .description("Run replay record -> compile -> replay execution path check")
            .option("--scope <scope>", "scope override")
            .option("--mode <mode>", "simulate|strict|guided", "simulate")
            .option("--backend <backend>", "local_process|sandbox_sync|sandbox_async", "local_process")
            .option("--project-id <projectId>", "project id for sandbox budget scoping")
            .option("--allow-sensitive-exec", "allow sensitive command execution", false)
            .option("--allow-local-exec", "explicitly set allow_local_exec=true")
            .option("--sensitive-review-mode <mode>", "block|warn", "block")
            .action(async (opts: {
              scope?: string;
              mode?: string;
              backend?: string;
              projectId?: string;
              allowSensitiveExec?: boolean;
              allowLocalExec?: boolean;
              sensitiveReviewMode?: string;
            }) => {
              const scope = opts.scope?.trim() || resolved.scope;
              const requestedMode = String(opts.mode ?? "simulate").trim().toLowerCase();
              const mode: ReplayRunMode = requestedMode === "strict" || requestedMode === "guided" || requestedMode === "simulate"
                ? (requestedMode as ReplayRunMode)
                : "simulate";
              const requestedBackend = String(opts.backend ?? "local_process").trim().toLowerCase();
              const backend: ReplayExecutionBackend = requestedBackend === "sandbox_sync" || requestedBackend === "sandbox_async" || requestedBackend === "local_process"
                ? (requestedBackend as ReplayExecutionBackend)
                : "local_process";
              const requestedSensitiveReviewMode = String(opts.sensitiveReviewMode ?? "block").trim().toLowerCase();
              const sensitiveReviewMode: ReplaySensitiveReviewMode = requestedSensitiveReviewMode === "warn" ? "warn" : "block";
              const projectId = typeof opts.projectId === "string" && opts.projectId.trim() ? opts.projectId.trim() : undefined;
              const allowLocalExec = opts.allowLocalExec === true ? true : mode !== "simulate";
              const runId = randomUUID();
              try {
                const started = await client.replayRunStart({
                  scope,
                  runId,
                  goal: "OpenClaw replay selfcheck flow",
                  metadata: { source: "openclaw-cli", selfcheck: true },
                });
                const startedRunId = String(started?.run_id ?? started?.run?.run_id ?? runId);
                const stepBefore = await client.replayStepBefore({
                  scope,
                  runId: startedRunId,
                  stepIndex: 1,
                  toolName: "command",
                  toolInput: { argv: ["echo", "aionis replay selfcheck"] },
                  expectedOutputSignature: { stdout_contains: "aionis replay selfcheck" },
                  preconditions: [{ kind: "command_available", command: "echo" }],
                  safetyLevel: "auto_ok",
                  metadata: { source: "openclaw-cli", selfcheck: true },
                });
                const stepAfter = await client.replayStepAfter({
                  scope,
                  runId: startedRunId,
                  stepId: typeof stepBefore?.step_id === "string" ? stepBefore.step_id : undefined,
                  stepIndex: 1,
                  status: "success",
                  outputSignature: { contains: "aionis replay selfcheck" },
                  postconditions: [{ kind: "stdout_contains", value: "aionis replay selfcheck" }],
                  metadata: { source: "openclaw-cli", selfcheck: true },
                });
                const ended = await client.replayRunEnd({
                  scope,
                  runId: startedRunId,
                  status: "success",
                  summary: "Replay selfcheck completed",
                  successCriteria: { replay_api_paths: "ok" },
                  metrics: { steps: 1 },
                  metadata: { source: "openclaw-cli", selfcheck: true },
                });
                const compiled = await client.replayPlaybookCompileFromRun({
                  scope,
                  runId: startedRunId,
                  name: `openclaw-replay-selfcheck-${new Date().toISOString().slice(0, 10)}`,
                  riskProfile: "low",
                  allowPartial: false,
                  metadata: { source: "openclaw-cli", selfcheck: true },
                });
                const playbookId = String(compiled?.playbook_id ?? compiled?.playbook?.playbook_id ?? "");
                const replayRun = playbookId
                  ? await client.replayPlaybookRun({
                    scope,
                    playbookId,
                    mode,
                    projectId,
                    executionBackend: backend,
                    sensitiveReviewMode,
                    allowSensitiveExec: opts.allowSensitiveExec === true ? true : undefined,
                    allowLocalExec,
                    params: { selfcheck: true, auto_confirm: true, workdir: "." },
                    maxSteps: 20,
                  })
                  : null;
                const replayStatus = extractReplayRunStatus(replayRun);
                const replayRunId = extractReplayRunId(replayRun);
                const replayRunUri = extractReplayRunUri(replayRun);
                const replayUnexpectedFailure =
                  mode !== "simulate" && (
                    replayStatus == null
                    || replayStatus === "failed"
                    || (mode === "strict" && replayStatus !== "success")
                  );
                if (replayUnexpectedFailure) {
                  throw new Error(`replay run returned unexpected status for mode=${mode}: ${String(replayStatus ?? "null")}`);
                }

                console.log(
                  JSON.stringify(
                    {
                      overall_status: "pass",
                      scope,
                      mode,
                      execution_backend: backend,
                      sensitive_review_mode: sensitiveReviewMode,
                      allow_local_exec: allowLocalExec,
                      project_id: projectId ?? null,
                      run_id: startedRunId,
                      step_id: stepBefore?.step_id ?? null,
                      run_end_status: ended?.status ?? "success",
                      playbook_id: playbookId || null,
                      replay_status: replayStatus,
                      replay_run_id: replayRunId,
                      replay_run_uri: replayRunUri,
                      replay_readiness: replayRun?.summary?.replay_readiness ?? null,
                      step_after_ok: !!stepAfter,
                    },
                    null,
                    2,
                  ),
                );
              } catch (err) {
                console.error(
                  JSON.stringify(
                    {
                      overall_status: "fail",
                      scope,
                      mode,
                      execution_backend: backend,
                      sensitive_review_mode: sensitiveReviewMode,
                      allow_local_exec: allowLocalExec,
                      project_id: projectId ?? null,
                      run_id: runId,
                      error: formatError(err),
                    },
                    null,
                    2,
                  ),
                );
              }
            });
        },
        { commands: ["aionis-memory"] },
      );
    }

    if (typeof api.on === "function" && resolved.autoRecall) {
      api.on("before_agent_start", async (event: any, ctx: any) => {
        try {
          const prompt = extractPrompt(event);
          if (!prompt || prompt.length < 3) return;

          const sessionId = extractSessionId(event, ctx);
          const runId = sessionId ?? undefined;
          const scope = buildScope(resolved, event, ctx, sessionId);
          const context = {
            source: "openclaw-before_agent_start",
            user_id: resolved.userId,
            run_id: runId,
          };

          const candidates = extractCandidateTools(event);
          const out = await client.contextAssemble(scope, prompt, context, candidates);
          const contextText = summarizeContextAsText(out);
          const decision = out?.tools;
          if (sessionId && decision && typeof decision === "object") {
            const d = decision as ToolDecision;
            lastDecisionBySession.set(sessionId, {
              decisionId: d.decision_id,
              decisionUri: d.decision_uri,
              candidates,
              selected: String(d.selected_tool ?? d.selected ?? ""),
            });
          }

          if (!contextText) return;
          const clip = contextText.slice(0, resolved.contextCharBudget);
          if (resolved.debug) {
            api.logger.info(`openclaw-aionis-memory: injected context chars=${clip.length} scope=${scope}`);
          }
          return {
            prependContext: `<aionis-context>\n${clip}\n</aionis-context>`,
          };
        } catch (err) {
          api.logger.warn(`openclaw-aionis-memory: autoRecall failed: ${formatError(err)}`);
          return undefined;
        }
      });
    }

    if (typeof api.on === "function" && resolved.autoCapture) {
      api.on("agent_end", async (event: any, ctx: any) => {
        try {
          if (!event?.success) return;
          const allMessages = Array.isArray(event?.messages) ? event.messages : [];
          const dialogue = gatherRecentDialogue(allMessages, resolved.captureMessageLimit);
          if (dialogue.length === 0) return;

          const sessionId = extractSessionId(event, ctx);
          const scope = buildScope(resolved, event, ctx, sessionId);
          const lines = dialogue.map((m) => `${m.role}: ${m.content}`);
          const inputText = cleanText(lines.join("\n"), 8000);
          await client.write(scope, inputText, {
            source: "openclaw-agent_end",
            user_id: resolved.userId,
            session_id: sessionId,
          });

          if (!resolved.autoPolicyFeedback || !sessionId) return;

          const pending = lastDecisionBySession.get(sessionId);
          const usedTool = inferUsedTool(event);
          if (!usedTool) return;

          const feedbackCandidates = pending?.candidates?.length ? pending.candidates : extractCandidateTools(event);
          if (feedbackCandidates.length === 0) return;

          const feedback = await client.toolsFeedback({
            scope,
            runId: sessionId,
            decisionId: pending?.decisionId,
            decisionUri: pending?.decisionUri,
            context: { source: "openclaw-agent_end", user_id: resolved.userId },
            candidates: feedbackCandidates,
            selectedTool: usedTool,
            outcome: "positive",
            note: "auto feedback from successful turn",
            inputText: `Turn succeeded with tool ${usedTool}`,
          });

          const updatedRules = Number(feedback?.updated_rules ?? 0);
          const selected = pending?.selected?.trim() ?? "";
          if (selected && selected !== usedTool) {
            api.logger.info(`openclaw-aionis-memory: policy switch detected (selected=${selected}, executed=${usedTool})`);
          } else {
            api.logger.info(`openclaw-aionis-memory: policy switch reduced (selected aligns with executed tool=${usedTool})`);
          }
          api.logger.info(`openclaw-aionis-memory: rule confidence updated (updated_rules=${updatedRules})`);
        } catch (err) {
          api.logger.warn(`openclaw-aionis-memory: autoCapture failed: ${formatError(err)}`);
        }
      });
    }

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "openclaw-aionis-memory",
        start: () => {
          api.logger.info(
            `openclaw-aionis-memory: started (base=${resolved.baseUrl}, tenant=${resolved.tenantId}, scope=${resolved.scope}, scopeMode=${resolved.scopeMode}, preset=${resolved.preset})`,
          );
        },
        stop: () => {
          api.logger.info("openclaw-aionis-memory: stopped");
        },
      });
    }
  },
};

function extractCandidateTools(event: any): string[] {
  const out: string[] = [];
  const raw = (event && (event.toolCandidates ?? event.candidates ?? event.tools)) || [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) out.push(item.trim());
      else if (item && typeof item === "object") {
        const maybe = (item as Record<string, unknown>).name;
        if (typeof maybe === "string" && maybe.trim()) out.push(maybe.trim());
      }
    }
  }
  return Array.from(new Set(out));
}

function inferUsedTool(event: any): string | null {
  const direct = [event?.selectedTool, event?.toolName, event?.tool, event?.selected_tool];
  for (const v of direct) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const calls = event?.toolCalls;
  if (Array.isArray(calls) && calls.length > 0) {
    const first = calls[0];
    if (first && typeof first === "object") {
      const name = (first as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }
  return null;
}

function toNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function extractReplayRunStatus(v: unknown): string | null {
  const obj = toRecord(v);
  const run = toRecord(obj.run);
  const result = toRecord(obj.result);
  const summary = toRecord(obj.summary);
  return (
    toNonEmptyString(run.status)
    ?? toNonEmptyString(obj.status)
    ?? toNonEmptyString(obj.run_status)
    ?? toNonEmptyString(result.status)
    ?? toNonEmptyString(summary.replay_readiness)
    ?? null
  );
}

function extractReplayRunId(v: unknown): string | null {
  const obj = toRecord(v);
  const run = toRecord(obj.run);
  const result = toRecord(obj.result);
  return (
    toNonEmptyString(run.run_id)
    ?? toNonEmptyString(obj.run_id)
    ?? toNonEmptyString(obj.replay_run_id)
    ?? toNonEmptyString(result.run_id)
    ?? null
  );
}

function extractReplayRunUri(v: unknown): string | null {
  const obj = toRecord(v);
  const run = toRecord(obj.run);
  return toNonEmptyString(run.run_uri) ?? toNonEmptyString(obj.run_uri) ?? null;
}

function formatError(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const status = rec.status;
    const code = rec.code;
    const message = rec.message;
    if (typeof status === "number" || typeof code === "string" || typeof message === "string") {
      return `status=${String(status ?? "n/a")}, code=${String(code ?? "n/a")}, message=${String(message ?? "")}`;
    }
  }
  return String(err);
}

export default plugin;
