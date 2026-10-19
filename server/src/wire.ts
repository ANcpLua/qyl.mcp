/**
 * Internal aliases over the generated Qyl contract types. This module contains
 * no handwritten wire shape; TypeSpec and its published JSON Schema own both
 * compile-time types and runtime validators.
 */

export type {
  LogRecord as QylLogRecord,
  SessionEntity as QylSession,
  Span as QylSpan,
  Trace as QylTrace,
} from "@ancplua/qyl-api-schema/types";
