import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { fetch } from "undici";
import { z } from "zod";
const ConfigSchema = z.object({
    baseUrl: z.string().url().default(process.env.AIONIS_BASE_URL ?? "http://127.0.0.1:3001"),
    apiKey: z.string().default(process.env.AIONIS_API_KEY ?? ""),
    tenantId: z.string().min(1).default(process.env.AIONIS_TENANT_ID ?? "default"),
    scope: z.string().min(1).default(process.env.AIONIS_SCOPE ?? "default"),
    scopePrefix: z.string().min(1).default(process.env.AIONIS_SCOPE_PREFIX ?? "clawbot"),
    scopeMode: z
        .enum(["fixed", "session", "project"])
        .default(process.env.AIONIS_SCOPE_MODE ?? "project"),
    userId: z.string().min(1).default(process.env.AIONIS_USER_ID ?? "default"),
    actor: z.string().min(1).default(process.env.AIONIS_ACTOR ?? "openclaw-aionis-plugin"),
    preset: z.enum(["compact", "policy-first", "custom"]).default(process.env.AIONIS_PRESET ?? "compact"),
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
const PRESET_DEFAULTS = {
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
function parseBoolean(v, fallback) {
    if (v == null || v === "")
        return fallback;
    const raw = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw))
        return true;
    if (["0", "false", "no", "off"].includes(raw))
        return false;
    return fallback;
}
function parseIntEnv(v, fallback) {
    if (v == null || v.trim() === "")
        return fallback;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n))
        return fallback;
    return n;
}
function toRecord(v) {
    if (v && typeof v === "object" && !Array.isArray(v))
        return v;
    return {};
}
function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}
function applyPreset(rawCfg, cfg) {
    if (cfg.preset === "custom")
        return cfg;
    const preset = PRESET_DEFAULTS[cfg.preset];
    const out = { ...cfg };
    if (!hasOwn(rawCfg, "recallLimit"))
        out.recallLimit = preset.recallLimit;
    if (!hasOwn(rawCfg, "contextCharBudget"))
        out.contextCharBudget = preset.contextCharBudget;
    if (!hasOwn(rawCfg, "captureMessageLimit"))
        out.captureMessageLimit = preset.captureMessageLimit;
    if (!hasOwn(rawCfg, "includeShadow"))
        out.includeShadow = preset.includeShadow;
    if (!hasOwn(rawCfg, "strictTools"))
        out.strictTools = preset.strictTools;
    return out;
}
function cleanText(input, max = 1200) {
    return input.replace(/\s+/g, " ").trim().slice(0, max);
}
function sanitizeScope(input) {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-:]+|[-:]+$/g, "")
        .slice(0, 120);
}
function extractSessionId(event, ctx) {
    const candidates = [
        ctx?.sessionKey,
        ctx?.sessionId,
        ctx?.runId,
        event?.sessionKey,
        event?.sessionId,
        event?.runId,
        event?.run_id,
    ];
    for (const v of candidates) {
        if (typeof v === "string" && v.trim().length > 0)
            return v.trim();
    }
    return null;
}
function extractPrompt(event) {
    if (typeof event?.prompt === "string")
        return event.prompt.trim();
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (!msg || typeof msg !== "object")
            continue;
        const role = msg.role;
        if (role !== "user")
            continue;
        const text = extractMessageText(msg);
        if (text)
            return text;
    }
    return "";
}
function extractMessageText(msg) {
    if (!msg || typeof msg !== "object")
        return "";
    const obj = msg;
    const content = obj.content;
    if (typeof content === "string")
        return content.trim();
    if (Array.isArray(content)) {
        const chunks = [];
        for (const block of content) {
            if (!block || typeof block !== "object")
                continue;
            const text = block.text;
            if (typeof text === "string" && text.trim().length > 0)
                chunks.push(text.trim());
        }
        return chunks.join("\n").trim();
    }
    return "";
}
function gatherRecentDialogue(messages, maxItems) {
    const out = [];
    const tail = messages.slice(Math.max(0, messages.length - maxItems));
    for (const msg of tail) {
        if (!msg || typeof msg !== "object")
            continue;
        const role = msg.role;
        if (role !== "user" && role !== "assistant")
            continue;
        let text = extractMessageText(msg);
        if (!text)
            continue;
        text = text.replace(/<aionis-context>[\s\S]*?<\/aionis-context>\s*/g, "").trim();
        if (!text)
            continue;
        out.push({ role: String(role), content: cleanText(text, 2400) });
    }
    return out;
}
function extractWorkspacePath(event, ctx) {
    const candidates = [
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
        if (typeof v === "string" && v.trim().length > 0)
            return v.trim();
    }
    return null;
}
function projectScopeTokenFromPath(pathLike) {
    const base = sanitizeScope(basename(pathLike)) || "project";
    const hash = createHash("sha1").update(pathLike).digest("hex").slice(0, 8);
    return `${base}-${hash}`;
}
function buildScope(cfg, event, ctx, sessionId) {
    if (cfg.scopeMode === "fixed")
        return cfg.scope;
    if (cfg.scopeMode === "project") {
        const workspacePath = extractWorkspacePath(event, ctx);
        if (!workspacePath)
            return cfg.scope;
        return sanitizeScope(`${cfg.scopePrefix}:${projectScopeTokenFromPath(workspacePath)}`) || cfg.scope;
    }
    if (!sessionId)
        return cfg.scope;
    return sanitizeScope(`${cfg.scopePrefix}:${sessionId}`) || cfg.scope;
}
function summarizeContextAsText(out) {
    const merged = out?.layered_context?.merged_text;
    if (typeof merged === "string" && merged.trim().length > 0)
        return merged.trim();
    const recallText = out?.recall?.context?.text;
    if (typeof recallText === "string" && recallText.trim().length > 0)
        return recallText.trim();
    return "";
}
function toToolText(title, payload) {
    return {
        content: [{ type: "text", text: title }],
        details: payload,
    };
}
function parseEnvFile(path) {
    const out = {};
    if (!existsSync(path))
        return out;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const idx = trimmed.indexOf("=");
        if (idx <= 0)
            continue;
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}
function resolveOpenClawConfigPath() {
    const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
    if (fromEnv)
        return fromEnv;
    return join(homedir(), ".openclaw", "openclaw.json");
}
function writeJsonWithBackup(path, value) {
    if (existsSync(path)) {
        const backupPath = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(path, backupPath);
    }
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return path;
}
function autoWritePluginConfigFromClawbotEnv(cfg) {
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
    cfg;
    logger;
    constructor(cfg, logger) {
        this.cfg = cfg;
        this.logger = logger;
    }
    headers(extra) {
        return {
            "content-type": "application/json",
            "x-api-key": this.cfg.apiKey,
            "x-tenant-id": this.cfg.tenantId,
            ...(extra ?? {}),
        };
    }
    async post(path, payload) {
        const base = this.cfg.baseUrl.replace(/\/+$/g, "");
        const url = `${base}${path}`;
        const res = await fetch(url, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(payload),
        });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        }
        catch {
            json = null;
        }
        if (!res.ok) {
            const err = {
                status: res.status,
                code: String(json?.code ?? json?.error ?? `http_${res.status}`),
                message: String(json?.message ?? text ?? `Request failed: ${res.status}`),
                details: json?.details,
            };
            throw err;
        }
        return (json ?? {});
    }
    async health() {
        const base = this.cfg.baseUrl.replace(/\/+$/g, "");
        const res = await fetch(`${base}/health`, { headers: this.headers() });
        if (!res.ok)
            throw new Error(`health failed: ${res.status}`);
        return (await res.json());
    }
    async write(scope, inputText, metadata) {
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
    async recallText(scope, queryText, limit) {
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
    async contextAssemble(scope, queryText, context, toolCandidates) {
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
    async toolsSelect(scope, runId, context, candidates) {
        return this.post("/v1/memory/tools/select", {
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
    async toolsFeedback(args) {
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
}
const plugin = {
    id: "openclaw-aionis-memory",
    name: "Memory (Aionis)",
    description: "Aionis-powered memory plugin for OpenClaw with auto-recall and auto-capture.",
    kind: "memory",
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
    register(api) {
        const rawCfg = toRecord(api.pluginConfig);
        const parsed = ConfigSchema.parse(rawCfg);
        const resolved = applyPreset(rawCfg, parsed);
        if (!resolved.apiKey) {
            api.logger.warn("openclaw-aionis-memory: apiKey missing. Set plugin config apiKey or env AIONIS_API_KEY.");
        }
        const client = new AionisClient(resolved, api.logger);
        const lastDecisionBySession = new Map();
        api.logger.info(`openclaw-aionis-memory: registered (base=${resolved.baseUrl}, tenant=${resolved.tenantId}, scopeMode=${resolved.scopeMode}, preset=${resolved.preset}, autoRecall=${resolved.autoRecall}, autoCapture=${resolved.autoCapture}, autoPolicyFeedback=${resolved.autoPolicyFeedback})`);
        api.registerTool({
            name: "aionis_memory_search",
            label: "Aionis Memory Search",
            description: "Search relevant memory snippets from Aionis recall_text endpoint.",
            parameters: Type.Object({
                query: Type.String({ description: "Natural language query" }),
                limit: Type.Optional(Type.Number({ description: "Result limit (default plugin setting)" })),
                scope: Type.Optional(Type.String({ description: "Optional explicit scope override" })),
            }),
            async execute(_toolCallId, params) {
                try {
                    const p = toRecord(params);
                    const query = String(p.query ?? "").trim();
                    if (!query)
                        return toToolText("query is required", { ok: false });
                    const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
                    const limit = Number.isFinite(p.limit) ? Number(p.limit) : resolved.recallLimit;
                    const out = await client.recallText(scope, query, Math.max(1, Math.min(50, limit)));
                    const text = String(out?.context?.text ?? "").trim() || "No relevant memory found.";
                    return toToolText(text, out);
                }
                catch (err) {
                    return toToolText(`aionis_memory_search failed: ${formatError(err)}`, { ok: false, error: err });
                }
            },
        }, { name: "aionis_memory_search" });
        api.registerTool({
            name: "aionis_memory_store",
            label: "Aionis Memory Store",
            description: "Persist a memory write into Aionis.",
            parameters: Type.Object({
                text: Type.String({ description: "Text to store as memory" }),
                scope: Type.Optional(Type.String({ description: "Optional explicit scope override" })),
            }),
            async execute(_toolCallId, params) {
                try {
                    const p = toRecord(params);
                    const text = String(p.text ?? "").trim();
                    if (!text)
                        return toToolText("text is required", { ok: false });
                    const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
                    const out = await client.write(scope, cleanText(text, 4000));
                    return toToolText(`Stored memory (commit_id=${String(out?.commit_id ?? "n/a")})`, out);
                }
                catch (err) {
                    return toToolText(`aionis_memory_store failed: ${formatError(err)}`, { ok: false, error: err });
                }
            },
        }, { name: "aionis_memory_store" });
        api.registerTool({
            name: "aionis_memory_context",
            label: "Aionis Context Assemble",
            description: "Assemble layered context from Aionis memory and policy services.",
            parameters: Type.Object({
                query: Type.String({ description: "Query text" }),
                candidates: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
                runId: Type.Optional(Type.String()),
                scope: Type.Optional(Type.String()),
            }),
            async execute(_toolCallId, params) {
                try {
                    const p = toRecord(params);
                    const query = String(p.query ?? "").trim();
                    if (!query)
                        return toToolText("query is required", { ok: false });
                    const runId = typeof p.runId === "string" ? p.runId : undefined;
                    const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
                    const candidates = Array.isArray(p.candidates)
                        ? p.candidates.filter((v) => typeof v === "string" && v.trim().length > 0)
                        : undefined;
                    const context = {
                        source: "openclaw-tool",
                        user_id: resolved.userId,
                        run_id: runId,
                    };
                    const out = await client.contextAssemble(scope, query, context, candidates);
                    const text = summarizeContextAsText(out);
                    return toToolText(text || "Context assembled.", out);
                }
                catch (err) {
                    return toToolText(`aionis_memory_context failed: ${formatError(err)}`, { ok: false, error: err });
                }
            },
        }, { name: "aionis_memory_context" });
        api.registerTool({
            name: "aionis_policy_select",
            label: "Aionis Policy Select",
            description: "Select a tool with Aionis policy loop (tools/select).",
            parameters: Type.Object({
                runId: Type.String(),
                candidates: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
                context: Type.Optional(Type.Any()),
                scope: Type.Optional(Type.String()),
            }),
            async execute(_toolCallId, params) {
                try {
                    const p = toRecord(params);
                    const runId = String(p.runId ?? "").trim();
                    const candidates = Array.isArray(p.candidates)
                        ? p.candidates.filter((v) => typeof v === "string" && v.trim().length > 0)
                        : [];
                    if (!runId || candidates.length === 0) {
                        return toToolText("runId and non-empty candidates are required", { ok: false });
                    }
                    const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : resolved.scope;
                    const context = toRecord(p.context);
                    const out = await client.toolsSelect(scope, runId, context, candidates);
                    return toToolText(`Selected tool: ${String(out.selected_tool ?? out.selected ?? "n/a")}`, out);
                }
                catch (err) {
                    return toToolText(`aionis_policy_select failed: ${formatError(err)}`, { ok: false, error: err });
                }
            },
        }, { name: "aionis_policy_select" });
        api.registerTool({
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
            async execute(_toolCallId, params) {
                try {
                    const p = toRecord(params);
                    const candidates = Array.isArray(p.candidates)
                        ? p.candidates.filter((v) => typeof v === "string" && v.trim().length > 0)
                        : [];
                    if (candidates.length === 0)
                        return toToolText("candidates are required", { ok: false });
                    const selectedTool = String(p.selectedTool ?? "").trim();
                    const inputText = String(p.inputText ?? "").trim();
                    if (!selectedTool || !inputText)
                        return toToolText("selectedTool and inputText are required", { ok: false });
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
                }
                catch (err) {
                    return toToolText(`aionis_policy_feedback failed: ${formatError(err)}`, { ok: false, error: err });
                }
            },
        }, { name: "aionis_policy_feedback" });
        if (typeof api.registerCli === "function") {
            api.registerCli(({ program }) => {
                const root = program.command("aionis-memory").description("Aionis memory helper commands");
                root
                    .command("bootstrap")
                    .description("Bootstrap local Aionis standalone and auto-write plugin config")
                    .option("--port <port>", "Aionis local port")
                    .option("--container <name>", "Docker container name")
                    .option("--volume <name>", "Docker data volume name")
                    .option("--skip-health", "Skip health probe after bootstrap", false)
                    .action(async (opts) => {
                    try {
                        const scriptPath = fileURLToPath(new URL("../bootstrap-local-standalone.sh", import.meta.url));
                        const env = { ...process.env };
                        if (opts.port?.trim())
                            env.AIONIS_PORT = opts.port.trim();
                        if (opts.container?.trim())
                            env.AIONIS_CONTAINER_NAME = opts.container.trim();
                        if (opts.volume?.trim())
                            env.AIONIS_DATA_VOLUME = opts.volume.trim();
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
                            const probeCfg = {
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
                    }
                    catch (err) {
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
                    }
                    catch (err) {
                        console.error(`health failed: ${formatError(err)}`);
                    }
                });
                root
                    .command("selfcheck")
                    .description("Run quick write + context + policy path check")
                    .option("--scope <scope>", "scope override")
                    .action(async (opts) => {
                    const scope = opts.scope?.trim() || resolved.scope;
                    const runId = `selfcheck_${Date.now()}`;
                    try {
                        const write = await client.write(scope, `Aionis selfcheck at ${new Date().toISOString()}`);
                        const context = await client.contextAssemble(scope, "selfcheck memory context", { source: "openclaw-cli", run_id: runId }, ["send_email", "create_ticket"]);
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
                        console.log(JSON.stringify({
                            overall_status: "pass",
                            scope,
                            run_id: runId,
                            write_commit_id: write?.commit_id,
                            selected_tool: select.selected_tool ?? select.selected,
                            decision_id: select.decision_id,
                            context_mode: context?.layered_context?.mode ?? null,
                            feedback_ok: !!feedback,
                        }, null, 2));
                    }
                    catch (err) {
                        console.error(JSON.stringify({
                            overall_status: "fail",
                            scope,
                            run_id: runId,
                            error: formatError(err),
                        }, null, 2));
                    }
                });
            }, { commands: ["aionis-memory"] });
        }
        if (typeof api.on === "function" && resolved.autoRecall) {
            api.on("before_agent_start", async (event, ctx) => {
                try {
                    const prompt = extractPrompt(event);
                    if (!prompt || prompt.length < 3)
                        return;
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
                        const d = decision;
                        lastDecisionBySession.set(sessionId, {
                            decisionId: d.decision_id,
                            decisionUri: d.decision_uri,
                            candidates,
                            selected: String(d.selected_tool ?? d.selected ?? ""),
                        });
                    }
                    if (!contextText)
                        return;
                    const clip = contextText.slice(0, resolved.contextCharBudget);
                    if (resolved.debug) {
                        api.logger.info(`openclaw-aionis-memory: injected context chars=${clip.length} scope=${scope}`);
                    }
                    return {
                        prependContext: `<aionis-context>\n${clip}\n</aionis-context>`,
                    };
                }
                catch (err) {
                    api.logger.warn(`openclaw-aionis-memory: autoRecall failed: ${formatError(err)}`);
                    return undefined;
                }
            });
        }
        if (typeof api.on === "function" && resolved.autoCapture) {
            api.on("agent_end", async (event, ctx) => {
                try {
                    if (!event?.success)
                        return;
                    const allMessages = Array.isArray(event?.messages) ? event.messages : [];
                    const dialogue = gatherRecentDialogue(allMessages, resolved.captureMessageLimit);
                    if (dialogue.length === 0)
                        return;
                    const sessionId = extractSessionId(event, ctx);
                    const scope = buildScope(resolved, event, ctx, sessionId);
                    const lines = dialogue.map((m) => `${m.role}: ${m.content}`);
                    const inputText = cleanText(lines.join("\n"), 8000);
                    await client.write(scope, inputText, {
                        source: "openclaw-agent_end",
                        user_id: resolved.userId,
                        session_id: sessionId,
                    });
                    if (!resolved.autoPolicyFeedback || !sessionId)
                        return;
                    const pending = lastDecisionBySession.get(sessionId);
                    const usedTool = inferUsedTool(event);
                    if (!usedTool)
                        return;
                    const feedbackCandidates = pending?.candidates?.length ? pending.candidates : extractCandidateTools(event);
                    if (feedbackCandidates.length === 0)
                        return;
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
                    }
                    else {
                        api.logger.info(`openclaw-aionis-memory: policy switch reduced (selected aligns with executed tool=${usedTool})`);
                    }
                    api.logger.info(`openclaw-aionis-memory: rule confidence updated (updated_rules=${updatedRules})`);
                }
                catch (err) {
                    api.logger.warn(`openclaw-aionis-memory: autoCapture failed: ${formatError(err)}`);
                }
            });
        }
        if (typeof api.registerService === "function") {
            api.registerService({
                id: "openclaw-aionis-memory",
                start: () => {
                    api.logger.info(`openclaw-aionis-memory: started (base=${resolved.baseUrl}, tenant=${resolved.tenantId}, scope=${resolved.scope}, scopeMode=${resolved.scopeMode}, preset=${resolved.preset})`);
                },
                stop: () => {
                    api.logger.info("openclaw-aionis-memory: stopped");
                },
            });
        }
    },
};
function extractCandidateTools(event) {
    const out = [];
    const raw = (event && (event.toolCandidates ?? event.candidates ?? event.tools)) || [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item === "string" && item.trim())
                out.push(item.trim());
            else if (item && typeof item === "object") {
                const maybe = item.name;
                if (typeof maybe === "string" && maybe.trim())
                    out.push(maybe.trim());
            }
        }
    }
    return Array.from(new Set(out));
}
function inferUsedTool(event) {
    const direct = [event?.selectedTool, event?.toolName, event?.tool, event?.selected_tool];
    for (const v of direct) {
        if (typeof v === "string" && v.trim())
            return v.trim();
    }
    const calls = event?.toolCalls;
    if (Array.isArray(calls) && calls.length > 0) {
        const first = calls[0];
        if (first && typeof first === "object") {
            const name = first.name;
            if (typeof name === "string" && name.trim())
                return name.trim();
        }
    }
    return null;
}
function formatError(err) {
    if (!err)
        return "unknown error";
    if (typeof err === "string")
        return err;
    if (typeof err === "object") {
        const rec = err;
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
