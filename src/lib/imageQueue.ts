export type ImageGenJobData = {
  prompt: string;
  isExplicit: boolean;
  kind: "avatar" | "background";
};

export type ImageGenJobResult = {
  bytes: Buffer;
  provider: string;
};

export type ImageGenJobReturn = {
  jobId: string;
  promise: Promise<ImageGenJobResult>;
};

function setting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
const MAX_CONCURRENT = setting("IMAGE_GEN_WORKER_CONCURRENCY", 4, 1, 32);
const MAX_WAIT_MS = setting("IMAGE_GEN_WAIT_TIMEOUT_MS", 60000, 10, 300000);
const MAX_QUEUE_DEPTH = setting("IMAGE_GEN_MAX_QUEUE_DEPTH", 50, 0, 1000);
let active = 0;
let closed = false;
const waiters: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
const busy = (message: string) => Object.assign(new Error(message), { status: 503, expose: true });

export async function acquireImageGenSlot(): Promise<void> {
  if (closed) throw busy("Image generation is shutting down. Please retry shortly.");
  if (active < MAX_CONCURRENT) { active++; return; }
  if (waiters.length >= MAX_QUEUE_DEPTH) throw busy("Image generation queue is full. Please retry shortly.");
  await new Promise<void>((resolve, reject) => {
    const entry = { resolve, reject, timer: setTimeout(() => {
      const index = waiters.indexOf(entry);
      if (index !== -1) waiters.splice(index, 1);
      reject(busy("Image generation wait timed out. Please retry."));
    }, MAX_WAIT_MS) };
    waiters.push(entry);
  });
  // release transfers its occupied slot directly to this waiter.
}

export function releaseImageGenSlot(): void {
  if (active <= 0) return;
  const next = closed ? undefined : waiters.shift();
  if (next) { clearTimeout(next.timer); next.resolve(); }
  else active--;
}

export function startImageGenWorker(): void {
  console.log(`[image-queue] concurrency=${MAX_CONCURRENT}, maxWait=${MAX_WAIT_MS}ms, maxQueueDepth=${MAX_QUEUE_DEPTH}`);
}

export async function closeImageGenQueue(): Promise<void> {
  closed = true;
  for (const entry of waiters.splice(0)) {
    clearTimeout(entry.timer);
    entry.reject(busy("Image generation is shutting down. Please retry shortly."));
  }
}
