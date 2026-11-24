# Cloudflare FLUX.2 Klein 4B Multipart Fix

## Root cause
`@cf/black-forest-labs/flux-2-klein-4b` requires `multipart/form-data` input on Cloudflare Workers AI, even for text-only generation. The previous provider sent JSON (`Content-Type: application/json`), causing Cloudflare error 5006: `required properties at '/' are 'multipart'`.

## Fix
- Klein 4B now uses native `FormData`.
- `Content-Type` is intentionally not set manually so Node `fetch` supplies the multipart boundary.
- Prompt, guidance, width and height are sent as multipart fields.
- Avatar fallback requests 1024x1024.
- Background fallback requests 1920x1080.
- Other Cloudflare image models retain the existing JSON path.
- Response parsing supports both `result.image` and a direct `image` field.

## Provider chain
Pollinations -> Cloudflare FLUX.2 Klein 4B -> DiceBear (avatar-only emergency fallback).
