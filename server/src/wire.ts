/**
 * Internal aliases over the generated Qyl contract types. This module contains
 * no handwritten wire shape; TypeSpec and its published JSON Schema own both
 * compile-time types and runtime validators.
 */

import type {
  McpDataMode,
  McpToolStats,
} from "@ancplua/qyl-api-schema/types";

export type {
  LogRecord as QylLogRecord,
  McpDashboardStats,
  SessionEntity as QylSession,
  Span as QylSpan,
  Trace as QylTrace,
} from "@ancplua/qyl-api-schema/types";

export type Mode = McpDataMode;
export type McpToolRow = McpToolStats;

export {
  LogRecordSchema,
  McpDashboardStatsSchema,
  ModeSchema,
  ProblemDetailsSchema,
  SessionSchema,
  SpanSchema,
  TraceSchema,
  TraceSummarySchema,
} from "./contract-validation.js";
