import type { Context } from 'hono';
import type { IfVersionOptions } from '@haverstack/core';
import { parseIfMatch } from '@haverstack/core/wire';
import type { AppEnv } from '../types.js';

/**
 * The `ifVersion` an `If-Match` header carries. Every record write reads
 * one and checks it when present; a malformed header is core's 400, never a
 * fallthrough to unconditional. See docs/spec/wire-format.md
 * § Optimistic concurrency.
 */
export function ifMatchVersion(c: Context<AppEnv>): IfVersionOptions {
  return { ifVersion: parseIfMatch(c.req.header('If-Match')) };
}
