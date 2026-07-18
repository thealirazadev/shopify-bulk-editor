// Shared JSON error shape used by every loader/action error response.
// See docs/api-contracts.md for the contract this implements.
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

export function newRequestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

export function apiError(code: ErrorCode, message: string, requestId: string): ApiErrorBody {
  return { error: { code, message, requestId } };
}
