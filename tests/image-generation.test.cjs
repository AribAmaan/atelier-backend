const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_API_TOKEN = 'test-token';
process.env.CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
process.env.IMAGE_GEN_WORKER_CONCURRENCY = '1';
const { requestMediaResource, imageTimeoutMs } = require('../dist/lib/providers/mediaHttp');
const { generateCloudflareImage } = require('../dist/lib/providers/cloudflare');
const dbId = require.resolve('../dist/lib/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { prisma: {} } };
const { processImageGen } = require('../dist/routes/avatar');
const { acquireImageGenSlot, releaseImageGenSlot } = require('../dist/lib/imageQueue');
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; delete process.env.IMAGE_GEN_TIMEOUT_SECONDS; });
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
  global.fetch = async () => { calls++; return new Response(bytes, { headers: { 'content-type': 'image/png' } }); };
  assert.equal((await processImageGen(job)).provider, 'cloudflare');
  assert.equal(calls, 1);
});

test('HTML success from Cloudflare (first) triggers Pollinations fallback', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => {
    urls.push(url);
    return urls.length === 1 ? new Response('<html>upstream error</html>') : new Response(bytes);
  };
  const result = await processImageGen(job);
  assert.equal(result.provider, 'pollinations');
  assert.match(urls[0], /api.cloudflare.com/);
  assert.match(urls[1], /pollinations/);
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

test('Cloudflare timeout ignores a stale IMAGE_GEN_TIMEOUT_SECONDS=15 and has its own default', () => {
  const { cloudflareImageTimeoutMs } = require('../dist/lib/providers/mediaHttp');
  process.env.IMAGE_GEN_TIMEOUT_SECONDS = '15';
  delete process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS;
  assert.equal(cloudflareImageTimeoutMs(), 20000);
  process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS = '90';
  assert.equal(cloudflareImageTimeoutMs(), 90000);
  process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS = 'abc';
  assert.equal(cloudflareImageTimeoutMs(), 20000);
  delete process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS;
});

test('Klein request omits guidance unless CLOUDFLARE_IMAGE_GUIDANCE is set', async () => {
  const bytes = await png();
  global.fetch = async (url, init) => {
    assert.equal(init.body.get('guidance'), null);
    return Response.json({ success: true, result: { image: bytes.toString('base64') } });
  };
  await generateCloudflareImage(job.prompt, 1000, { width: 1024, height: 1024 });
});

test('hung Cloudflare is hedged: Pollinations starts after the hedge delay and wins fast', async () => {
  process.env.IMAGE_HEDGE_SECONDS = '1';
  const bytes = await png(); const urls = [];
  global.fetch = (url) => {
    urls.push(url);
    if (/api.cloudflare.com/.test(url)) return new Promise(() => {}); // hangs forever
    return Promise.resolve(new Response(bytes));
  };
  const t0 = Date.now();
  const result = await processImageGen(job);
  const took = Date.now() - t0;
  assert.equal(result.provider, 'pollinations');
  assert.ok(took >= 900 && took < 5000, `expected ~1s hedge, took ${took}ms`);
  delete process.env.IMAGE_HEDGE_SECONDS;
});

test('Cloudflare rate-limit opens its breaker so the next request skips it', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    if (/api.cloudflare.com/.test(url)) return new Response('Too Many Requests', { status: 429 });
    return new Response(bytes);
  };
  assert.equal((await processImageGen(job)).provider, 'pollinations');
  urls.length = 0;
  assert.equal((await processImageGen(job)).provider, 'pollinations');
  assert.ok(urls.every(u => /pollinations/.test(u)), 'Cloudflare should be skipped while its breaker is open');
});
