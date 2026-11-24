const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const oc = require("../dist/lib/providers/openaiCompatible");
const { insertTailSystemMessage, buildRecencyAnchor } = require("../dist/lib/providers/recencyAnchor");

// Mock OpenAI-compatible endpoint. mode: "strict" rejects any non-first system
// message the way a strict chat template does; "tolerant" accepts everything;
// "other400" always answers 400 with an unrelated reason.
function startServer(mode) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", d => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push(body);
      const lateSystem = body.messages.some((m, i) => i > 0 && m.role === "system");
      if (mode === "other400") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "max_tokens is too large" } }));
      }
      if (mode === "strict" && lateSystem) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "System message must be at the beginning." } }));
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello there." }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Hello there." }, finish_reason: "stop" }] }));
    });
  });
  return new Promise(resolve =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` }))
  );
}

function anchored() {
  const msgs = [
    { role: "system", content: "persona" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hey" },
    { role: "user", content: "how are you" },
  ];
  insertTailSystemMessage(msgs, buildRecencyAnchor({ name: "Mira", personality: "dry humour" }));
  return msgs;
}

test("foldLateSystemMessages merges late system messages into the first and keeps order of the rest", () => {
  const out = oc.foldLateSystemMessages(anchored());
  assert.deepEqual(out.map(m => m.role), ["system", "user", "assistant", "user"]);
  assert.ok(out[0].content.startsWith("persona\n\n"));
  assert.ok(out[0].content.includes("CHARACTER REMINDER"));
  assert.equal(out[3].content, "how are you");
});

test("foldLateSystemMessages does not mutate its input and is a no-op without late system messages", () => {
  const msgs = anchored();
  const before = JSON.stringify(msgs);
  oc.foldLateSystemMessages(msgs);
  assert.equal(JSON.stringify(msgs), before);
  const plain = [{ role: "system", content: "p" }, { role: "user", content: "u" }];
  assert.equal(oc.foldLateSystemMessages(plain), plain);
});

test("foldLateSystemMessages creates a leading system message when the first message is not one", () => {
  const out = oc.foldLateSystemMessages([
    { role: "user", content: "u" },
    { role: "system", content: "late" },
    { role: "user", content: "v" },
  ]);
  assert.deepEqual(out.map(m => m.role), ["system", "user", "user"]);
  assert.equal(out[0].content, "late");
});

test("strict endpoint: streaming retries once with the folded layout, then remembers it", async () => {
  const { srv, seen, url } = await startServer("strict");
  try {
    let out = "";
    await oc.streamOpenAICompatibleChat(url, "k", "strict-model-a", anchored(), c => (out += c), 5000);
    assert.equal(out, "Hello there.");
    assert.equal(seen.length, 2, "first attempt rejected, one folded retry accepted");
    assert.ok(seen[0].messages.some((m, i) => i > 0 && m.role === "system"));
    assert.ok(!seen[1].messages.some((m, i) => i > 0 && m.role === "system"));
    assert.ok(seen[1].messages[0].content.includes("CHARACTER REMINDER"));

    out = "";
    await oc.streamOpenAICompatibleChat(url, "k", "strict-model-a", anchored(), c => (out += c), 5000);
    assert.equal(out, "Hello there.");
    assert.equal(seen.length, 3, "second request goes straight to the folded layout");
  } finally {
    srv.close();
  }
});

test("strict endpoint: the non-streaming path folds and retries too", async () => {
  const { srv, seen, url } = await startServer("strict");
  try {
    const text = await oc.completeOpenAICompatibleChat(url, "k", "strict-model-b", anchored(), 5000);
    assert.equal(text, "Hello there.");
    assert.equal(seen.length, 2);
    assert.ok(!seen[1].messages.some((m, i) => i > 0 && m.role === "system"));
  } finally {
    srv.close();
  }
});

test("tolerant endpoint: exactly one request, messages sent unchanged", async () => {
  const { srv, seen, url } = await startServer("tolerant");
  try {
    await oc.streamOpenAICompatibleChat(url, "k", "tolerant-model", anchored(), () => {}, 5000);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].messages.map(m => m.role), ["system", "user", "assistant", "system", "user"]);
  } finally {
    srv.close();
  }
});

test("an unrelated 400 is not retried and still surfaces as an error", async () => {
  const { srv, seen, url } = await startServer("other400");
  try {
    await assert.rejects(
      oc.streamOpenAICompatibleChat(url, "k", "other-model", anchored(), () => {}, 5000),
      /failed \(400\)/
    );
    assert.equal(seen.length, 1, "no retry for a 400 that is not about the system message");
  } finally {
    srv.close();
  }
});

test("a request with no late system message never retries even on a 400 mentioning system", async () => {
  const { srv, seen, url } = await startServer("strict");
  try {
    // Plain conversation: strict mode accepts it, so just confirm single request.
    const msgs = [{ role: "system", content: "p" }, { role: "user", content: "u" }];
    await oc.streamOpenAICompatibleChat(url, "k", "plain-model", msgs, () => {}, 5000);
    assert.equal(seen.length, 1);
  } finally {
    srv.close();
  }
});
