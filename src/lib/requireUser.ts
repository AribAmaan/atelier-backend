import { asyncHandler } from "./asyncHandler";
import { getCurrentUserId } from "./auth";

/** Authenticate before allocating multipart upload buffers. */
export const requireUser = asyncHandler(async (req, res, next) => {
  const userId = await getCurrentUserId(req);
  if (!userId) { res.status(401).json({ error: "Not signed in." }); return; }
  res.locals.uploadUserId = userId;
  next();
});
