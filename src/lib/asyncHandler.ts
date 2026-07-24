import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not forward a rejected promise from an `async` route
 * handler to error-handling middleware — an unhandled throw (a Prisma call
 * failing, bcrypt throwing, etc.) just leaves the request hanging with no
 * response instead of producing a 500 like `server.ts`'s error middleware
 * is meant to. Wrapping every async handler with this closes that gap by
 * explicitly funneling any rejection into `next(err)`.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
