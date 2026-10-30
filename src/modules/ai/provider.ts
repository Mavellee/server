import { config } from "../../config.js";

export interface GenerateRequest {
  system: string;
  prompt: string;
  maxChars: number;
  signal: AbortSignal;
  /** Ask for a single JSON object. The caller still validates it. */
  json?: boolean;
}

export interface GenerateResult {
  text: string;
  model: string;
}

/** Product code depends only on this interface, so providers can be swapped by configuration. */
export interface AIProvider {
  readonly name: string;
  readonly enabled: boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export class ProviderUnavailable extends Error {}

class NoProvider implements AIProvider {
  name = "none";
  enabled = false;
  async generate(): Promise<GenerateResult> {
    throw new ProviderUnavailable("AI is not configured");
  }
}

// Roughly 4 characters per token; small headroom so the cap is enforced by us, not the model.
const tokensFor = (chars: number) => Math.ceil(chars / 3.5);

export class OllamaProvider implements AIProvider {
  name = "ollama";
  enabled = true;
  constructor(
    private url = config.ai.ollamaUrl,
    private model = config.ai.model,
  ) {}
  async generate({ system, prompt, maxChars, signal }: GenerateRequest) {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, system, prompt, stream: false, options: { num_predict: tokensFor(maxChars), temperature: 0.7 } }),
      signal,
    });
    if (!res.ok) throw new ProviderUnavailable(`Ollama responded ${res.status}`);
    const json = (await res.json()) as { response?: string };
    return { text: json.response ?? "", model: this.model };
  }
}

/** Any hosted API that speaks the OpenAI chat-completions format. The key stays on the server. */
export class OpenAICompatibleProvider implements AIProvider {
  name = "openai-compatible";
  enabled: boolean;
  constructor(
    private url = config.ai.apiUrl ?? "",
    private key = config.ai.apiKey ?? "",
    private model = config.ai.model,
    private tuning = true, // Anthropic's compatible endpoint rejects temperature and json_object; the prompt asks for JSON and callers validate it
  ) {
    this.enabled = !!(url && key);
  }
  async generate({ system, prompt, maxChars, signal, json }: GenerateRequest) {
    if (!this.enabled) throw new ProviderUnavailable("Hosted AI is not configured");
    const res = await fetch(`${this.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        max_tokens: tokensFor(maxChars),
        ...(this.tuning ? { temperature: 0.7 } : {}),
        ...(json && this.tuning ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal,
    });
    if (!res.ok) throw new ProviderUnavailable(`AI API responded ${res.status}`);
    const reply = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { text: reply.choices?.[0]?.message?.content ?? "", model: this.model };
  }
}

let provider: AIProvider = createProvider();

function createProvider(): AIProvider {
  if (config.ai.provider === "ollama") return new OllamaProvider();
  if (config.ai.provider === "openai-compatible") return new OpenAICompatibleProvider();
  if (config.ai.provider === "openai") return new OpenAICompatibleProvider("https://api.openai.com/v1", config.ai.openaiKey ?? "");
  if (config.ai.provider === "anthropic") return new OpenAICompatibleProvider("https://api.anthropic.com/v1", config.ai.anthropicKey ?? "", config.ai.model, false);
  if (config.ai.provider === "gemini") return new OpenAICompatibleProvider("https://generativelanguage.googleapis.com/v1beta/openai", config.ai.geminiKey ?? "");
  return new NoProvider();
}

export const getProvider = () => provider;
/** Test hook. */
export const setProvider = (p: AIProvider) => (provider = p);
