const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_API_TOKEN = 'test-token';
process.env.CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
process.env.IMAGE_GEN_WORKER_CONCURRENCY = '1';
// Most tests use the authenticated endpoint to avoid global legacy free-tier cooldowns.
process.env.POLLINATIONS_API_KEY = 'sk_test_default_key';
const { requestMediaResource, imageTimeoutMs } = require('../dist/lib/providers/mediaHttp');
const { generateCloudflareImage } = require('../dist/lib/providers/cloudflare');
const dbId = require.resolve('../dist/lib/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { prisma: {} } };
const { processImageGen } = require('../dist/routes/avatar');
const { acquireImageGenSlot, releaseImageGenSlot } = require('../dist/lib/imageQueue');
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; delete process.env.IMAGE_GEN_TIMEOUT_SECONDS; delete process.env.POLLINATIONS_TIMEOUT_SECONDS; delete process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS; process.env.POLLINATIONS_API_KEY = 'sk_test_default_key'; });
const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
const job = { kind: 'avatar', isExplicit: false, prompt: 'A friendly robot' };

test('Klein request uses FormData with dimensions and an automatically generated boundary', async () => {
  const bytes = await png();
  global.fetch = async (url, init) => {
    assert.match(url, /flux-2-klein-4b$/);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.headers['Content-Type'], undefined);
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('prompt'), job.prompt);
    assert.equal(init.body.get('width'), '1024');
    assert.equal(init.body.get('height'), '1024');
    assert.match(new Request(url, init).headers.get('content-type'), /multipart\/form-data; boundary=/);
    return Response.json({ success: true, result: { image: bytes.toString('base64') } });
  };
  assert.deepEqual(await generateCloudflareImage(job.prompt, 1000, { width: 1024, height: 1024 }), bytes);
});

test('Cloudflare supports raw images and direct image envelopes', async () => {
  const bytes = await png();
  for (const response of [new Response(bytes, { headers: { 'content-type': 'image/png' } }), Response.json({ image: bytes.toString('base64') })]) {
    global.fetch = async () => response;
    assert.deepEqual(await generateCloudflareImage(job.prompt, 1000), bytes);
  }
});

test('Cloudflare rejects success:false and malformed JSON image fields', async () => {
  for (const payload of [{ success: false, result: { image: 'abcd' } }, { result: { image: { bad: true } } }, {}]) {
    global.fetch = async () => Response.json(payload);
    await assert.rejects(generateCloudflareImage(job.prompt, 1000), /non-image response/);
  }
});

test('deadline includes stalled response body after headers arrive', async () => {
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(requestMediaResource('https://test.invalid', {}, 'Test', 25), /timed out/);
  assert.equal(cancelled, true);
});

test('deadline includes stalled headers and aborts the request', async () => {
  let signal;
  global.fetch = (_url, init) => { signal = init.signal; return new Promise(() => {}); };
  await assert.rejects(requestMediaResource('https://test.invalid', {}, 'Test', 25), /timed out/);
  assert.equal(signal.aborted, true);
});

test('declared oversized image is rejected and body cancelled', async () => {
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-length': String(22 * 1024 * 1024) },
  });
  await assert.rejects(requestMediaResource('https://test.invalid', {}, 'Test', 1000), /size limit/);
  assert.equal(cancelled, true);
});

test('streamed oversized image is rejected even without Content-Length', async () => {
  global.fetch = async () => new Response(new Uint8Array(22 * 1024 * 1024));
  await assert.rejects(requestMediaResource('https://test.invalid', {}, 'Test', 1000), /size limit/);
});

test('empty success response is rejected', async () => {
  global.fetch = async () => new Response('');
  await assert.rejects(requestMediaResource('https://test.invalid', {}, 'Test', 1000), /empty media/);
});

test('HTTP error body is bounded without waiting for an endless stream', async () => {
  global.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5000)); } }), { status: 429 });
  await assert.rejects(requestMediaResource('https://test.invalid', {}, 'Test', 1000), /API error 429/);
});

test('invalid timeout environment values recover to the default', () => {
  for (const value of ['banana', '', '0', '-1', 'Infinity', '121']) {
    process.env.IMAGE_GEN_TIMEOUT_SECONDS = value;
    assert.equal(imageTimeoutMs(), 45000);
  }
  process.env.IMAGE_GEN_TIMEOUT_SECONDS = '60';
  assert.equal(imageTimeoutMs(), 60000);
});

test('valid first provider image wins without calling fallback', async () => {
  const bytes = await png(); let calls = 0;
  global.fetch = async () => { calls++; return new Response(bytes); };
  assert.equal((await processImageGen(job)).provider, 'pollinations');
  assert.equal(calls, 1);
});

test('HTML success from first provider triggers Cloudflare fallback', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => {
    urls.push(url);
    return urls.length === 1 ? new Response('<html>upstream error</html>') : Response.json({ result: { image: bytes.toString('base64') } });
  };
  const result = await processImageGen(job);
  assert.equal(result.provider, 'cloudflare');
  assert.match(urls[1], /api.cloudflare.com/);
});

test('invalid Cloudflare image bytes trigger DiceBear fallback', async () => {
  const bytes = await png(); let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('unavailable', { status: 500 });
    if (calls === 2) return Response.json({ result: { image: Buffer.from('not an image').toString('base64') } });
    return new Response(bytes);
  };
  assert.equal((await processImageGen(job)).provider, 'dicebear-fallback');
  assert.equal(calls, 3);
});

test('background failure does not return a procedural avatar and releases queue slot', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('unavailable', { status: 500 }); };
  await assert.rejects(processImageGen({ ...job, kind: 'background' }), /All providers failed/);
  assert.equal(calls, 2);
  await acquireImageGenSlot();
  releaseImageGenSlot();
});

test('invalid final avatar fallback fails and releases queue slot', async () => {
  global.fetch = async () => new Response('not an image');
  await assert.rejects(processImageGen(job), /All providers failed/);
  await acquireImageGenSlot();
  releaseImageGenSlot();
});


test('Groq speech download also times out after headers', async () => {
  const { synthesizeGroqSpeech } = require('../dist/lib/providers/groq');
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(synthesizeGroqSpeech('Hello', 'hannah', 'test-key', 25), /Groq TTS request timed out/);
  assert.equal(cancelled, true);
});

test('Ollama readiness cancels the unused response body', async () => {
  const { isOllamaAvailable } = require('../dist/lib/providers/ollama');
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  assert.equal(await isOllamaAvailable(), true);
  assert.equal(cancelled, true);
});

test('registration rejects email addresses that exceed the existing database column', () => {
  const { validEmail } = require('../dist/lib/accountValidation');
  const suffix = '@' + 'b'.repeat(60) + '.' + 'c'.repeat(60) + '.com';
  assert.equal(validEmail('a'.repeat(191 - suffix.length) + suffix), true);
  assert.equal(validEmail('a'.repeat(192 - suffix.length) + suffix), false);
});

test('configured Pollinations key uses the current endpoint and Authorization header', async () => {
  const bytes = await png();
  process.env.POLLINATIONS_API_KEY = 'sk_test_pollinations_key';
  global.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/gen\.pollinations\.ai\/image\//);
    assert.doesNotMatch(String(url), /[?&]key=/);
    assert.equal(init.headers.Authorization, 'Bearer sk_test_pollinations_key');
    assert.match(String(url), /model=lykon%2Fdreamshaper-8-lcm/);
    assert.match(String(url), /width=768/);
    assert.match(String(url), /height=768/);
    assert.match(String(url), /steps=8/);
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  };
  assert.equal((await processImageGen(job)).provider, 'pollinations');
});

test('safe Pollinations backgrounds are generated natively at 1920x1080 with DreamShaper LCM 8 steps', async () => {
  const bytes = await png();
  process.env.POLLINATIONS_API_KEY = 'sk_test_pollinations_key';
  global.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/gen\.pollinations\.ai\/image\//);
    assert.equal(init.headers.Authorization, 'Bearer sk_test_pollinations_key');
    assert.match(String(url), /model=lykon%2Fdreamshaper-8-lcm/);
    assert.match(String(url), /width=1920/);
    assert.match(String(url), /height=1080/);
    assert.match(String(url), /steps=8/);
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  };
  const result = await processImageGen({ ...job, kind: 'background' });
  assert.equal(result.provider, 'pollinations');
});

test('legacy Pollinations FREE_LIMIT opens its per-IP breaker and avoids repeat calls', async () => {
  delete process.env.POLLINATIONS_API_KEY;
  const bytes = await png();
  let pollinationsCalls = 0;
  let cloudflareCalls = 0;
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://image.pollinations.ai/')) {
      pollinationsCalls++;
      assert.match(String(url), /steps=8/);
      return Response.json({
        status: 402,
        success: false,
        error: {
          code: 'FREE_LIMIT',
          message: 'Free limit reached: 1 image every 45 seconds per IP. Retry after 35s.',
        },
      }, { status: 402 });
    }
    cloudflareCalls++;
    assert.ok(init.body instanceof FormData);
    return Response.json({ success: true, result: { image: bytes.toString('base64') } });
  };

  assert.equal((await processImageGen(job)).provider, 'cloudflare');
  assert.equal((await processImageGen(job)).provider, 'cloudflare');
  assert.equal(pollinationsCalls, 1, 'Pollinations should be skipped while its breaker is open');
  assert.equal(cloudflareCalls, 2, 'Klein fallback should continue serving requests');
});

test('safe Cloudflare moderation rejection gets one SFW-framed retry', async () => {
  const bytes = await png();
  let cloudflareCalls = 0;
  global.fetch = async (url, init) => {
    if (String(url).includes('api.cloudflare.com')) {
      cloudflareCalls++;
      if (cloudflareCalls === 1) {
        return Response.json({ success: false, errors: [{ message: 'AiError: Your output has been flagged. Please choose another prompt', code: 3030 }] });
      }
      assert.ok(init.body instanceof FormData);
      assert.match(String(init.body.get('prompt')), /safe-for-work/i);
      return Response.json({ success: true, result: { image: bytes.toString('base64') } });
    }
    // The preceding rate-limit test leaves Pollinations in cooldown; use CF directly.
    return new Response('should not reach legacy Pollinations', { status: 500 });
  };

  assert.equal((await processImageGen(job)).provider, 'cloudflare');
  assert.equal(cloudflareCalls, 2);
});


// ---- Circuit breaker corrections (retry-hint units, chat-scope of isRateLimitError) ----
const { ProviderBreaker, isRateLimitError } = require('../dist/lib/providers/circuitBreaker');
const breakerDefaults = { cooldownSeconds: 30, timeoutTripThreshold: 2, timeoutCooldownSeconds: 15 };
const remainingMs = (b) => b.cooldownUntil - Date.now();

test('breaker honours an explicit seconds retry hint from Pollinations', () => {
  const b = new ProviderBreaker('t1', breakerDefaults, 'TESTBREAKER1');
  b.trip(new Error('Pollinations API error 402. Retry-After: 22s. {"error":{"message":"Free limit reached. Retry after 22s"}}'));
  assert.ok(remainingMs(b) > 20_000 && remainingMs(b) <= 25_000, `expected ~24s, got ${remainingMs(b)}ms`);
});

test('breaker does not misread "retry in 2 minutes" as 2 seconds', () => {
  const b = new ProviderBreaker('t2', breakerDefaults, 'TESTBREAKER2');
  b.trip(new Error('quota exceeded, retry in 2 minutes'));
  assert.ok(remainingMs(b) > 25_000, `expected the 30s default window, got ${remainingMs(b)}ms`);
});

test('breaker uses a 45s window for a 402 FREE_LIMIT with no retry hint, 30s for 503', () => {
  const a = new ProviderBreaker('t3', breakerDefaults, 'TESTBREAKER3');
  a.trip(new Error('Pollinations API error 402. {"error":{"code":"FREE_LIMIT"}}'));
  assert.ok(remainingMs(a) > 40_000, `402 window too short: ${remainingMs(a)}ms`);
  const c = new ProviderBreaker('t4', breakerDefaults, 'TESTBREAKER4');
  c.trip(new Error('Pollinations API error 503. SERVICE_UNAVAILABLE'));
  assert.ok(remainingMs(c) >= 29_000, `503 window too short: ${remainingMs(c)}ms`);
});

test('isRateLimitError keeps original chat-provider semantics (429/quota yes; bare 402/503/404 no)', () => {
  assert.equal(isRateLimitError(new Error('Request failed (429): too many')), true);
  assert.equal(isRateLimitError(new Error('quota exceeded')), true);
  assert.equal(isRateLimitError(new Error('Request to https://integrate.api.nvidia.com/v1 failed (404): Function not found')), false);
  assert.equal(isRateLimitError(new Error('upstream failed (503)')), false);
});
