import { requestMediaResource } from "./mediaHttp";
// Cloudflare Workers AI — free tier (10,000 "neurons"/day, resets daily,
// no credit card required) image generation. Requires a Cloudflare account
// ID + a Workers AI API token (Cloudflare dashboard -> AI -> Workers AI ->
// "Create a Workers AI API Token"). Set CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN to enable this provider; if unset, it's simply
// skipped in the fallback chain (see routes/avatar.ts).
//
// Default image model: FLUX.2 Klein 4B. Render can still override this via
// CLOUDFLARE_IMAGE_MODEL, but keeping the same value in render.yaml and here
// prevents local/production behavior from drifting.
const MODEL = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";

// Guidance is supported by FLUX.2 Klein and Leonardo Phoenix. The model-
// specific request builder below only includes it for compatible families.
const GUIDANCE = Number(process.env.CLOUDFLARE_IMAGE_GUIDANCE || "7");

type CloudflareImageSize = { width?: number; height?: number };

function isKleinModel(model: string): boolean {
  return model.includes("flux-2-klein");
}

// Most Workers AI image models accept JSON, but FLUX.2 Klein is different:
// Cloudflare requires multipart/form-data even for prompt-only generation.
// `fetch()` must be allowed to set the multipart Content-Type itself so the
// boundary is present; manually setting `multipart/form-data` would still be
// invalid because it would omit that boundary.
function buildKleinMultipartBody(prompt: string, size?: CloudflareImageSize): FormData {
  const form = new FormData();
  form.append("prompt", prompt);

  if (Number.isFinite(GUIDANCE)) {
    form.append("guidance", String(GUIDANCE));
  }
  if (size?.width) form.append("width", String(size.width));
  if (size?.height) form.append("height", String(size.height));

  return form;
}

// JSON request body for models that do not require multipart input. FLUX.2
// Klein is intentionally excluded and handled by buildKleinMultipartBody().
function buildJsonRequestBody(prompt: string): Record<string, unknown> {
  if (MODEL.includes("flux-1-schnell")) {
    return { prompt, steps: 8 };
  }
  if (MODEL.includes("phoenix") || MODEL.includes("flux-2")) {
    return { prompt, guidance: GUIDANCE, num_steps: 30 };
  }
  return { prompt };
}

export function isCloudflareConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

/**
 * Requests one image from Cloudflare Workers AI for the given prompt.
 * Returns PNG/JPEG bytes on success. Throws on any failure (missing
 * credentials, over the free daily neuron budget, network error, timeout)
 * so the caller can fall through to the next provider.
 *
 * FLUX.2 Klein requests are sent as multipart/form-data, including optional
 * width/height supplied by the caller. Other model families retain their
 * existing JSON request format.
 */
export async function generateCloudflareImage(
  prompt: string,
  timeoutMs: number,
  size?: CloudflareImageSize
): Promise<Buffer> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error("CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not set");
  if (!MODEL) throw new Error("CLOUDFLARE_IMAGE_MODEL is set but empty — provide a valid model name");

  const model = MODEL;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;


  const klein = isKleinModel(model);
  const body: BodyInit = klein
    ? buildKleinMultipartBody(prompt, size)
    : JSON.stringify(buildJsonRequestBody(prompt));

  // IMPORTANT: do not manually set Content-Type for FormData. Node's fetch
  // adds the required multipart boundary automatically.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
  };
  if (!klein) headers["Content-Type"] = "application/json";

  const { body: responseBody, contentType } = await requestMediaResource(
    url, { method: "POST", headers, body }, "Cloudflare Workers AI", timeoutMs
  );

  // Response shape differs by model family. Older models (SDXL, DreamShaper)
  // return raw image bytes with an image/* content-type. Flux models
  // (flux-1-schnell, flux-2 including Klein) return a JSON envelope with the image
  // as a base64 string at result.image, even on success — so a JSON
  // content-type here is NOT automatically an error, and needs to be
  // inspected before being treated as Cloudflare's
  // {"success":false,"errors":[...]} failure envelope.
  if (contentType.startsWith("image/")) {
    const bytes = responseBody;
    if (!bytes.length) throw new Error("Cloudflare Workers AI returned an empty image");
    return bytes;
  }

  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try { parsed = JSON.parse(responseBody.toString("utf8")); } catch { parsed = null; }
    const json = parsed as
      | { success?: boolean; result?: { image?: string }; image?: string; errors?: unknown[] }
      | null;

    // REST API normally wraps model output in result.image. Keep support for
    // a direct image field too because the model schema itself defines
    // `{ image: <base64> }` as the output shape.
    const encodedImage = json?.result?.image || json?.image;
    if (typeof encodedImage === "string" && encodedImage && (json?.success !== false)) {
      const bytes = Buffer.from(encodedImage, "base64");
      if (!bytes.length) throw new Error("Cloudflare Workers AI returned an empty image");
      return bytes;
    }

    throw new Error(
      `Cloudflare Workers AI returned non-image response: ${JSON.stringify(json).slice(0, 300)}`
    );
  }

  const errText = responseBody.toString("utf8");
  throw new Error(`Cloudflare Workers AI returned unexpected content-type "${contentType}": ${errText.slice(0, 300)}`);
}
