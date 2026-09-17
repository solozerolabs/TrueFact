// Stagehand v4 custom LLM client backed by a local oMLX server (Apple Silicon).
// Stagehand's ModelConfig has no baseUrl, so a local model must ride the
// `ClientLLM.generate` callback. Contract (from dist/index.mjs):
//   input:  { messages:[{role,content}], systemPrompt?, temperature?, stopSequences?,
//             responseFormat?: {type:"json_schema"|"text", name?, schema?}, tools? }
//   output: { role, content:[{type:"text",text}], outputFormat:"json_schema"|"text",
//             structuredContent?, stopReason?, usage? }   (strictObject — no extra keys)
// Structured calls use oMLX's json_schema response_format (constrained decoding),
// which is what makes a local model reliable enough to drive `act`.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function omlxConfig() {
  const s = JSON.parse(readFileSync(join(homedir(), ".omlx", "settings.json"), "utf8"));
  const host = s.server?.host === "0.0.0.0" ? "127.0.0.1" : s.server?.host ?? "127.0.0.1";
  return { base: `http://${host}:${s.server?.port ?? 8000}/v1`, key: s.auth?.api_key ?? "" };
}

export async function omlxModelId(cfg = omlxConfig()) {
  const r = await fetch(`${cfg.base}/models`, { headers: { authorization: `Bearer ${cfg.key}` } });
  const j = await r.json();
  return j.data?.[0]?.id;
}

const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// Stagehand message content is a block or array of blocks; flatten text, note images.
function toText(content) {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image omitted]" : b.type === "tool_result" ? toText(b.content) : ""))
    .join("\n")
    .trim();
}

export function omlxModel(modelId, opts = {}) {
  const cfg = opts.config ?? omlxConfig();
  const log = opts.log ?? (() => {});
  return {
    async generate(params) {
      const messages = [];
      if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
      for (const m of params.messages) messages.push({ role: m.role, content: toText(m.content) });

      const structured = params.responseFormat?.type === "json_schema";
      const body = {
        model: modelId,
        messages,
        temperature: params.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 2048,
        ...(params.stopSequences?.length ? { stop: params.stopSequences } : {}),
        ...(structured
          ? { response_format: { type: "json_schema", json_schema: { name: params.responseFormat.name, schema: params.responseFormat.schema } } }
          : {}),
      };
      const t0 = Date.now();
      const r = await fetch(`${cfg.base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`oMLX ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      const raw = j.choices?.[0]?.message?.content ?? "";
      const text = structured ? raw : stripThink(raw);
      const usage = j.usage
        ? { inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0, totalTokens: j.usage.total_tokens ?? 0 }
        : undefined;
      log(`  oMLX ${structured ? "json" : "text"} ${Date.now() - t0}ms in=${usage?.inputTokens} out=${usage?.outputTokens}`);

      if (structured) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const m = raw.match(/\{[\s\S]*\}/);
          parsed = m ? JSON.parse(m[0]) : {};
        }
        return { role: "assistant", outputFormat: "json_schema", content: [{ type: "text", text: raw }], structuredContent: parsed, ...(usage ? { usage } : {}) };
      }
      return { role: "assistant", outputFormat: "text", content: [{ type: "text", text }], ...(usage ? { usage } : {}) };
    },
  };
}
