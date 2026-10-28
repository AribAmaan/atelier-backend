const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_API_TOKEN = 'test-token';
process.env.CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
process.env.IMAGE_GEN_WORKER_CONCURRENCY = '1';
const { requestMediaResource, imageTimeoutMs, cloudflareImageTimeoutMs, imageTotalBudgetMs } = require('../dist/lib/providers/mediaHttp');
const { generateCloudflareImage } = require('../dist/lib/providers/cloudflare');
const dbId = require.resolve('../dist/lib/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { prisma: {} } };
const { processImageGen } = require('../dist/routes/avatar');
const { acquireImageGenSlot, releaseImageGenSlot } = require('../dist/lib/imageQueue');
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; delete process.env.IMAGE_GEN_TIMEOUT_SECONDS; delete process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS; delete process.env.IMAGE_GEN_TOTAL_BUDGET_SECONDS; });
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

const cfJson = bytes => Response.json({ success: true, result: { image: bytes.toString('base64') } });
const isCf = url => /api\.cloudflare\.com/.test(url);
const explicitJob = { ...job, isExplicit: true };

test('normal jobs try Cloudflare first and do not call Pollinations when it succeeds', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => { urls.push(url); return cfJson(bytes); };
  assert.equal((await processImageGen(job)).provider, 'cloudflare');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /api\.cloudflare\.com/);
});

test('explicit jobs keep Pollinations first (uncensored model) and skip Cloudflare on success', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => { urls.push(url); return new Response(bytes); };
  assert.equal((await processImageGen(explicitJob)).provider, 'pollinations');
  assert.equal(urls.length, 1);
  assert.doesNotMatch(urls[0], /cloudflare/);
});

test('bad Cloudflare image falls back to Pollinations for normal jobs', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => {
    urls.push(url);
    return isCf(url) ? Response.json({ result: { image: Buffer.from('<html>').toString('base64') } }) : new Response(bytes);
  };
  assert.equal((await processImageGen(job)).provider, 'pollinations');
  assert.match(urls[0], /api\.cloudflare\.com/);
  assert.doesNotMatch(urls[1], /cloudflare/);
});

test('HTML success from Pollinations triggers Cloudflare fallback for explicit jobs', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => {
    urls.push(url);
    return isCf(url) ? cfJson(bytes) : new Response('<html>upstream error</html>');
  };
  const result = await processImageGen(explicitJob);
  assert.equal(result.provider, 'cloudflare');
  assert.match(urls[1], /api\.cloudflare\.com/);
});

test('invalid Cloudflare image bytes and failing Pollinations trigger DiceBear fallback', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => {
    urls.push(url);
    if (isCf(url)) return Response.json({ result: { image: Buffer.from('not an image').toString('base64') } });
    if (/pollinations/.test(url)) return new Response('unavailable', { status: 500 });
    return new Response(bytes);
  };
  assert.equal((await processImageGen(job)).provider, 'dicebear-fallback');
  assert.equal(urls.length, 3);
});

test('background jobs ask Cloudflare for 1536x864 (16:9) and avatars for 1024x1024', async () => {
  const bytes = await png(); const sizes = [];
  global.fetch = async (url, init) => { sizes.push([init.body.get('width'), init.body.get('height')]); return cfJson(bytes); };
  await processImageGen({ ...job, kind: 'background' });
  await processImageGen(job);
  assert.deepEqual(sizes, [['1536', '864'], ['1024', '1024']]);
});

test('background failure does not return a procedural avatar and releases queue slot', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('unavailable', { status: 500 }); };
  await assert.rejects(processImageGen({ ...job, kind: 'background' }), /All providers failed/);
  assert.equal(calls, 3); // Pollinations once + Cloudflare twice (a 5xx gets one retry)
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

test('Cloudflare timeout defaults to 60s, is independent of IMAGE_GEN_TIMEOUT_SECONDS, and recovers from bad values', () => {
  assert.equal(cloudflareImageTimeoutMs(), 60000);
  process.env.IMAGE_GEN_TIMEOUT_SECONDS = '20';
  assert.equal(cloudflareImageTimeoutMs(), 60000);
  for (const value of ['banana', '', '0', '-1', 'Infinity', '301']) {
    process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS = value;
    assert.equal(cloudflareImageTimeoutMs(), 60000);
  }
  process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS = '90';
  assert.equal(cloudflareImageTimeoutMs(), 90000);
});

test('Cloudflare retries once on a 5xx and then succeeds', async () => {
  const bytes = await png(); let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('upstream hiccup', { status: 503 })
      : Response.json({ success: true, result: { image: bytes.toString('base64') } });
  };
  assert.deepEqual(await generateCloudflareImage(job.prompt, 30000), bytes);
  assert.equal(calls, 2);
});

test('Cloudflare retries once on capacity error 3040', async () => {
  const bytes = await png(); let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('{"errors":[{"code":3040,"message":"Capacity temporarily exceeded"}]}', { status: 400 })
      : Response.json({ result: { image: bytes.toString('base64') } });
  };
  assert.deepEqual(await generateCloudflareImage(job.prompt, 30000), bytes);
  assert.equal(calls, 2);
});

test('Cloudflare does not retry auth, rate-limit or timeout failures', async () => {
  for (const make of [
    () => new Response('{"errors":[{"code":10000,"message":"Authentication error"}]}', { status: 401 }),
    () => new Response('quota exceeded', { status: 429 }),
  ]) {
    let calls = 0;
    global.fetch = async () => { calls++; return make(); };
    await assert.rejects(generateCloudflareImage(job.prompt, 30000), /API error/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  global.fetch = () => { calls++; return new Promise(() => {}); };
  await assert.rejects(generateCloudflareImage(job.prompt, 50), /timed out/);
  assert.equal(calls, 1);
});

test('Cloudflare gives up after one retry', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('down', { status: 502 }); };
  await assert.rejects(generateCloudflareImage(job.prompt, 30000), /API error 502/);
  assert.equal(calls, 2);
});

test('Cloudflare is not given the shorter Pollinations timeout', async () => {
  const bytes = await png();
  process.env.IMAGE_GEN_TIMEOUT_SECONDS = '1';
  global.fetch = async url => {
    if (/cloudflare/.test(url)) {
      await new Promise(r => setTimeout(r, 1500)); // slower than the 1s image timeout
      return Response.json({ result: { image: bytes.toString('base64') } });
    }
    return new Response('<html>bad</html>');
  };
  assert.equal((await processImageGen(job)).provider, 'cloudflare');
});

test('total image budget defaults to 75s and recovers from bad values', () => {
  assert.equal(imageTotalBudgetMs(), 75000);
  for (const value of ['banana', '', '0', '9', '-1', 'Infinity', '301']) {
    process.env.IMAGE_GEN_TOTAL_BUDGET_SECONDS = value;
    assert.equal(imageTotalBudgetMs(), 75000);
  }
  process.env.IMAGE_GEN_TOTAL_BUDGET_SECONDS = '30';
  assert.equal(imageTotalBudgetMs(), 30000);
});

test('Cloudflare attempt is clamped to the total budget, so a hung provider cannot hold a customer longer than it', async () => {
  process.env.IMAGE_GEN_TOTAL_BUDGET_SECONDS = '10';
  process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS = '300'; // would hang for 5 min without the clamp
  const urls = []; const started = Date.now();
  global.fetch = (url, init) => {
    urls.push(url);
    if (isCf(url)) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    return Promise.resolve(new Response('x', { status: 500 }));
  };
  await assert.rejects(processImageGen({ ...job, kind: 'background' }), /cloudflare: .*timed out.*pollinations: skipped, total time budget used up/s);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 9000 && elapsed < 12000, `elapsed ${elapsed}ms`);
  assert.equal(urls.length, 1); // Pollinations never started
});

// Keep last: a quota error opens Cloudflare's circuit breaker for this process.
test('Cloudflare quota exhaustion trips the breaker so later requests skip it', async () => {
  const bytes = await png(); const urls = [];
  global.fetch = async url => {
    urls.push(url);
    return isCf(url)
      ? new Response('{"errors":[{"code":4006,"message":"you have used up your daily free allocation of 10,000 neurons"}]}', { status: 400 })
      : new Response(bytes);
  };
  assert.equal((await processImageGen(job)).provider, 'pollinations'); // CF fails once, then fallback
  const cfCallsAfterFirst = urls.filter(isCf).length;
  assert.equal(cfCallsAfterFirst, 1); // 4006 is not retried
  assert.equal((await processImageGen(job)).provider, 'pollinations');
  assert.equal(urls.filter(isCf).length, cfCallsAfterFirst); // breaker open: Cloudflare skipped
});
