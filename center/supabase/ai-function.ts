// Supabase Edge Function "ai": turns spoken text into tasks with Claude.
// Dashboard: Edge Functions → Deploy a new function → name it ai → paste this → Deploy.
// Then Edge Functions → Secrets → add ANTHROPIC_API_KEY.
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: isMember } = await sb.rpc("is_member");
    if (!isMember) return json({ error: "not a team member" }, 403);

    const { prompt } = await req.json();
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 20000) return json({ error: "bad prompt" }, 400);

    const msg = await anthropic.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
    if (msg.stop_reason === "refusal") return json({ error: "declined" }, 422);
    const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    return json({ text });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "rate limited, try again soon" }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: e.message }, 502);
    return json({ error: String(e) }, 500);
  }
});
