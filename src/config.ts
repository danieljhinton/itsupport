import "dotenv/config";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : !["false", "0", "no"].includes(v.toLowerCase())));

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url().optional(),
  DASHBOARD_TOKEN: z.string().optional(),
  TWILIO_VALIDATE_SIGNATURE: bool(true),

  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high"]).default("low"),

  HALO_MCP_URL: z.string().url(),
  HALO_AUTH_URL: z.string().url(),
  HALO_CLIENT_ID: z.string().min(1),
  HALO_CLIENT_SECRET: z.string().min(1),
  HALO_SCOPE: z.string().default("all"),
  HALO_TENANT: z.string().optional(),
  HALO_WEB_URL: z.string().optional(),
  HALO_TOOL_POLICY: z.string().default("config/tool-policy.json"),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TTS_PROVIDER: z.string().default("Google"),
  TTS_VOICE: z.string().default("en-AU-Neural2-C"),
  TRANSCRIPTION_PROVIDER: z.string().default("Deepgram"),
  WELCOME_GREETING: z
    .string()
    .default("Hi, you've reached the IT service desk. I'm the virtual assistant. How can I help today?"),

  COMPANY_NAME: z.string().default("Contoso"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

/** Parse and validate environment variables once. Blank values count as unset. */
export function config(): Config {
  if (cached) return cached;
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (check your .env):\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
