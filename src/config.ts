import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");
const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().nonnegative());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000),
  APP_ORIGIN: z.string().url().default("http://localhost:5180"),
  DATABASE_URL: z.string().min(1),
  SESSION_TTL_DAYS: int(30),
  COOKIE_SECURE: bool,
  TRUST_PROXY: int(0),
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: int(5),
  VIDEO_MAX_MB: int(50),
  VIDEO_MAX_SECONDS: int(30),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Knot <hello@example.com>"),
  AI_PROVIDER: z.enum(["none", "ollama", "openai-compatible", "openai", "gemini", "anthropic"]).default("none"),
  AI_MODEL: z.string().default("llama3.2:3b"),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  AI_API_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ASTRO_ENCRYPTION_KEY: z.string().optional(),
  ASTRO_RETENTION_DAYS: int(365),
  ASTRO_AI_TIMEOUT_MS: int(45000),
  ASTRO_MAX_OUTPUT_CHARS: int(24000),
  ASTRO_MONTHLY_REPORT_LIMIT: int(200),
  ASTRO_USER_DAILY_LIMIT: int(5),
  AI_TIMEOUT_MS: int(12000),
  AI_MAX_OUTPUT_CHARS: int(600),
  AI_MAX_CONCURRENCY: int(2),
  AI_DAILY_USER_LIMIT: int(20),
  AI_DAILY_GLOBAL_LIMIT: int(2000),
  COMPAT_WEIGHT_RELATIONSHIP_GOALS: int(5),
  COMPAT_WEIGHT_COMMUNICATION: int(3),
  COMPAT_WEIGHT_LIFESTYLE: int(3),
  COMPAT_WEIGHT_INTERESTS: int(2),
  COMPAT_WEIGHT_VALUES: int(4),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  port: env.PORT,
  appOrigin: env.APP_ORIGIN,
  databaseUrl: env.DATABASE_URL,
  sessionTtlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  cookieSecure: env.COOKIE_SECURE || env.NODE_ENV === "production",
  trustProxy: env.TRUST_PROXY,
  uploadDir: env.UPLOAD_DIR,
  maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
  media: { maxPhotos: 6, maxVideos: 2, captionMax: 200, videoMaxBytes: env.VIDEO_MAX_MB * 1024 * 1024, videoMaxSeconds: env.VIDEO_MAX_SECONDS },
  mail: {
    host: env.SMTP_HOST || undefined,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
  },
  ai: {
    provider: env.AI_PROVIDER,
    model: env.AI_MODEL,
    ollamaUrl: env.OLLAMA_URL,
    apiUrl: env.AI_API_URL,
    apiKey: env.AI_API_KEY,
    openaiKey: env.OPENAI_API_KEY,
    geminiKey: env.GEMINI_API_KEY,
    anthropicKey: env.ANTHROPIC_API_KEY,
    timeoutMs: env.AI_TIMEOUT_MS,
    maxOutputChars: env.AI_MAX_OUTPUT_CHARS,
    maxConcurrency: Math.max(1, env.AI_MAX_CONCURRENCY),
    dailyUserLimit: env.AI_DAILY_USER_LIMIT,
    dailyGlobalLimit: env.AI_DAILY_GLOBAL_LIMIT,
  },
  astro: {
    encryptionKey: env.ASTRO_ENCRYPTION_KEY,
    retentionDays: env.ASTRO_RETENTION_DAYS,
    aiTimeoutMs: env.ASTRO_AI_TIMEOUT_MS,
    maxOutputChars: env.ASTRO_MAX_OUTPUT_CHARS,
    monthlyReportLimit: env.ASTRO_MONTHLY_REPORT_LIMIT,
    userDailyLimit: env.ASTRO_USER_DAILY_LIMIT,
  },
  compatibilityWeights: {
    RELATIONSHIP_GOALS: env.COMPAT_WEIGHT_RELATIONSHIP_GOALS,
    COMMUNICATION: env.COMPAT_WEIGHT_COMMUNICATION,
    LIFESTYLE: env.COMPAT_WEIGHT_LIFESTYLE,
    INTERESTS: env.COMPAT_WEIGHT_INTERESTS,
    VALUES: env.COMPAT_WEIGHT_VALUES,
  },
  logLevel: env.LOG_LEVEL,
};
