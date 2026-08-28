import { Router } from "express";
import OpenAI from "openai";

const router = Router();
const MAX_IMAGE_BASE64_LENGTH = 8_000_000;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

interface IdentificationCandidate {
  cardName: string;
  setName?: string;
  cardNumber?: string;
  confidence?: number;
}

function parseCandidates(content: string): IdentificationCandidate[] {
  const plain = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(plain) as {
      candidates?: unknown;
      cardName?: unknown;
    };
    const rawCandidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
      : parsed.cardName
        ? [parsed]
        : [];

    return rawCandidates
      .map((candidate): IdentificationCandidate | null => {
        if (!candidate || typeof candidate !== "object") return null;
        const value = candidate as Record<string, unknown>;
        const cardName = typeof value.cardName === "string" ? value.cardName.trim() : "";
        if (!cardName) return null;
        const rawConfidence = Number(value.confidence);
        return {
          cardName,
          setName: typeof value.setName === "string" ? value.setName.trim() : undefined,
          cardNumber: typeof value.cardNumber === "string" ? value.cardNumber.trim() : undefined,
          confidence: Number.isFinite(rawConfidence)
            ? Math.max(0, Math.min(1, rawConfidence))
            : undefined,
        };
      })
      .filter((candidate): candidate is IdentificationCandidate => candidate !== null)
      .slice(0, 3);
  } catch {
    return plain && !plain.startsWith("{") && !plain.startsWith("[")
      ? [{ cardName: plain.slice(0, 140) }]
      : [];
  }
}

router.post("/identify-card", async (req, res) => {
  const { imageBase64, mimeType = "image/jpeg" } = req.body as {
    imageBase64?: string;
    mimeType?: string;
  };

  if (!imageBase64) {
    res.status(400).json({ error: "Missing imageBase64" });
    return;
  }
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    res.status(400).json({ error: "Unsupported image type" });
    return;
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    res.status(413).json({ error: "Image is too large. Use a smaller photo." });
    return;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.6-luna",
      max_completion_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
            {
              type: "text",
              text:
                "Identify this trading card. Return ONLY valid JSON with this exact shape: " +
                '{"candidates":[{"cardName":"string","setName":"string or empty","cardNumber":"string or empty","confidence":0.0}]}. ' +
                "Return up to 3 likely candidates in descending confidence. Use only what is visible in the image; do not invent details. " +
                "Confidence must be a number from 0 to 1. If the card cannot be identified, return {\"candidates\":[]}.",
            },
          ],
        },
      ],
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const candidates = parseCandidates(content);
    res.json({
      candidates,
      cardName: candidates[0]?.cardName ?? "",
    });
  } catch (err) {
    res.status(502).json({ error: "Vision request failed", detail: String(err) });
  }
});

export default router;
