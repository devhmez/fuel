import Anthropic from "@anthropic-ai/sdk";

interface Env {
  ANTHROPIC_API_KEY?: string;
  APP_PASSCODE?: string;
  MOCK?: string;
  ASSETS: Fetcher;
}

// One model for everything; effort is tuned per route.
const MODEL = "claude-opus-5-5";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------- schemas ----------

const num = { type: "number" };
const str = { type: "string" };
const strList = { type: "array", items: str };
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const macros = { calories: num, protein_g: num, carbs_g: num, fat_g: num };

const SCAN_SCHEMA = obj({
  dish_name: str,
  items: { type: "array", items: obj({ name: str, grams: num, ...macros }) },
  confidence: { type: "string", enum: ["low", "medium", "high"] },
  notes: str,
});

const PLAN_SCHEMA = obj({
  ...macros,
  expected_weekly_change_kg: num,
  explanation: str,
  tips: strList,
});

const PHYSIQUE_SCHEMA = obj({
  summary: str,
  body_fat_estimate: str,
  changes_since_last: str,
  strengths: strList,
  focus_areas: strList,
  training_tips: strList,
  recommended_targets: obj(macros),
  target_reason: str,
});

// ---------- prompts ----------

const SCAN_SYSTEM = `You are a precise nutrition analyst inside a personal food-tracking app.
From the photo and/or the user's note, identify each distinct food item, estimate its edible weight in grams from visual cues (a standard dinner plate is ~26 cm, also use cutlery, hands, packaging), and give calories, protein, carbs and fat per item using standard nutrition data (USDA / CIQUAL).
The user lives in Tunisia: recognise North African and Mediterranean dishes (couscous, lablabi, brik, ojja, mloukhia, makloub, chapati, kafteji, tajine, mlewi, etc.) and their usual preparation, which often uses generous olive oil.
List likely hidden calories (cooking oil, butter, sauces, dressings, sugary drinks) as their own items.
If the user's note gives weights, counts or ingredients, trust it over the photo.
Be realistic, not optimistic: people underestimate portions. Round grams to the nearest 5 and calories to the nearest 5.
If there is no food, return an empty items list and say so in notes.
notes: one or two short sentences on what is uncertain and how the user could make the estimate better. Keep dish_name short (max 5 words).`;

const PLAN_SYSTEM = `You are a no-nonsense, evidence-based nutrition coach for someone going back to the gym.
You get their profile, a formula-based starting target, and their recent intake. Check the target, adjust it if you have a good reason, and explain it in plain, friendly language (short sentences, no jargon, max 90 words).
Protein 1.6–2.2 g/kg, fat at least 0.6 g/kg, carbs fill the rest. Never go below 1500 kcal for men or 1200 kcal for women.
Tips: 3 to 5 short, practical tips that fit a Tunisian diet and a normal budget.
This is general fitness guidance, not medical advice.`;

const PHYSIQUE_SYSTEM = `You are an honest, encouraging physique coach. The user sends a progress photo of themselves (and sometimes the previous one) with their stats.
Assess visible muscle development and body fat as a rough range (this is a visual estimate, say so if lighting or pose makes it hard). Compare with the previous photo when there is one; if not, say this is the baseline.
Be direct and specific, never insulting. Keep summary under 70 words. 2–4 items per list, each under 15 words.
recommended_targets: daily calories and macros for their goal given what you see and their data (protein 1.6–2.2 g/kg).
This is general fitness guidance, not medical advice.`;

// ---------- Claude ----------

type Effort = "low" | "medium" | "high";

async function askClaude(
  env: Env,
  opts: {
    system: string;
    content: Anthropic.Beta.BetaContentBlockParam[];
    schema: Record<string, unknown>;
    effort: Effort;
  },
): Promise<unknown> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, "Server has no ANTHROPIC_API_KEY set.");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const params = {
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: opts.system,
    output_config: {
      effort: opts.effort,
      format: { type: "json_schema", schema: opts.schema },
    },
    messages: [{ role: "user", content: opts.content }],
  };

  let res: Anthropic.Beta.BetaMessage;
  try {
    // `fallbacks: "default"` may be newer than the SDK's types, so cast the params.
    res = (await client.beta.messages.create(params as never)) as Anthropic.Beta.BetaMessage;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(500, "The API key is invalid.");
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, "Too many requests, try again in a minute.");
    if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, `Bad request: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `Claude API error (${err.status}). Try again.`);
    throw err;
  }

  if (res.stop_reason === "refusal") throw new HttpError(422, "The AI couldn't analyse this one. Try another photo.");
  if (res.stop_reason === "max_tokens") throw new HttpError(502, "The answer was cut off. Try again.");

  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  if (!text) throw new HttpError(502, "Empty answer from the AI.");
  return JSON.parse(text);
}

function imageBlock(dataUrl: unknown): Anthropic.Beta.BetaImageBlockParam {
  if (typeof dataUrl !== "string") throw new HttpError(400, "Missing image.");
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) throw new HttpError(400, "Image must be a JPEG, PNG or WebP data URL.");
  if (m[2].length > 4_500_000) throw new HttpError(413, "Image is too large.");
  return {
    type: "image",
    source: { type: "base64", media_type: m[1] as "image/jpeg" | "image/png" | "image/webp", data: m[2] },
  };
}

const text = (t: string): Anthropic.Beta.BetaTextBlockParam => ({ type: "text", text: t });

// ---------- routes ----------

async function scan(env: Env, body: any) {
  if (env.MOCK === "1") return mockScan();
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (body.image) content.push(imageBlock(body.image));
  const note = String(body.note ?? "").slice(0, 500).trim();
  if (!body.image && !note) throw new HttpError(400, "Send a photo or describe the meal.");
  content.push(text(note ? `My note: ${note}` : "Analyse this meal."));
  return askClaude(env, { system: SCAN_SYSTEM, content, schema: SCAN_SCHEMA, effort: "low" });
}

async function plan(env: Env, body: any) {
  if (env.MOCK === "1") return mockPlan(body);
  const content = [
    text(
      `Profile: ${JSON.stringify(body.profile)}\nFormula target: ${JSON.stringify(body.targets)}\n` +
        `Average intake over the last 7 logged days: ${JSON.stringify(body.recent ?? null)}\n` +
        `Weight log (oldest first, kg): ${JSON.stringify(body.weights ?? [])}`,
    ),
  ];
  return askClaude(env, { system: PLAN_SYSTEM, content, schema: PLAN_SCHEMA, effort: "medium" });
}

async function physique(env: Env, body: any) {
  if (env.MOCK === "1") return mockPhysique();
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (body.previous?.image) {
    content.push(text(`PREVIOUS check-in (${body.previous.date}). Coach summary then: ${body.previous.summary ?? "n/a"}`));
    content.push(imageBlock(body.previous.image));
  }
  content.push(text("CURRENT photo:"));
  content.push(imageBlock(body.image));
  content.push(
    text(
      `Profile: ${JSON.stringify(body.profile)}\nCurrent targets: ${JSON.stringify(body.targets)}\n` +
        `Average intake last 7 logged days: ${JSON.stringify(body.recent ?? null)}\n` +
        `Weight log (oldest first, kg): ${JSON.stringify(body.weights ?? [])}\n` +
        `User note: ${String(body.note ?? "").slice(0, 500)}`,
    ),
  );
  return askClaude(env, { system: PHYSIQUE_SYSTEM, content, schema: PHYSIQUE_SCHEMA, effort: "medium" });
}

const ROUTES: Record<string, (env: Env, body: any) => Promise<unknown>> = { scan, plan, physique };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      const route = ROUTES[url.pathname.slice(5)];
      if (!route) throw new HttpError(404, "Not found");
      if (request.method !== "POST") throw new HttpError(405, "Use POST");
      if (!env.APP_PASSCODE) throw new HttpError(500, "Server has no APP_PASSCODE set.");
      if (request.headers.get("x-app-passcode") !== env.APP_PASSCODE)
        throw new HttpError(401, "Wrong passcode. Set it in the Me tab.");
      const body = await request.json().catch(() => {
        throw new HttpError(400, "Invalid JSON");
      });
      return json(await route(env, body));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------- mock data (MOCK=1) ----------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mockScan() {
  await wait(900);
  return {
    dish_name: "Chicken couscous",
    items: [
      { name: "Couscous (cooked)", grams: 220, calories: 245, protein_g: 8, carbs_g: 51, fat_g: 0.5 },
      { name: "Chicken thigh", grams: 140, calories: 290, protein_g: 34, carbs_g: 0, fat_g: 17 },
      { name: "Vegetables (carrot, zucchini, chickpeas)", grams: 150, calories: 110, protein_g: 4, carbs_g: 19, fat_g: 1.5 },
      { name: "Olive oil", grams: 10, calories: 90, protein_g: 0, carbs_g: 0, fat_g: 10 },
    ],
    confidence: "medium",
    notes: "Oil is hard to see. Tell me if it was cooked with more than a spoon.",
  };
}

async function mockPlan(body: any) {
  await wait(900);
  const t = body.targets ?? { calories: 2400, protein_g: 160, carbs_g: 260, fat_g: 70 };
  return {
    ...t,
    expected_weekly_change_kg: -0.4,
    explanation: "This is a moderate deficit, so you lose fat while keeping strength in the gym. High protein protects your muscle.",
    tips: ["Eggs or lablabi with eggs for an easy protein breakfast", "Weigh your couscous for a week to learn your portions", "Keep olive oil to one measured spoon per meal"],
  };
}

async function mockPhysique() {
  await wait(1200);
  return {
    summary: "This is your baseline. Decent frame and shoulder width; midsection carries most of the fat. A steady cut with heavy training will show a lot of change in 8–12 weeks.",
    body_fat_estimate: "18–22%",
    changes_since_last: "First check-in, no comparison yet.",
    strengths: ["Good shoulder width", "Solid arm base"],
    focus_areas: ["Lose fat around the waist", "Build upper chest", "Back thickness"],
    training_tips: ["Push / pull / legs, 4–5 days a week", "Add weight or reps every week", "8–10k steps daily"],
    recommended_targets: { calories: 2300, protein_g: 165, carbs_g: 240, fat_g: 70 },
    target_reason: "Moderate deficit with high protein to drop fat while keeping muscle.",
  };
}
