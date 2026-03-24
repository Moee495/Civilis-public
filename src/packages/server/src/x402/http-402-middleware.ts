import type { RequestHandler } from 'express';
import { x402Middleware, X402RouteConfig } from './x402-xlayer.js';

export function buildHttp402Middleware(
  routes: Record<string, X402RouteConfig>,
): RequestHandler {
  // The official x402 SDK is installed for future facilitator compatibility,
  // while X Layer traffic is validated through the hybrid middleware below.
  return x402Middleware(routes);
}
