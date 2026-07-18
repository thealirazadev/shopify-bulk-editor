// Structured JSON line logger. No console.log in committed code; use this
// everywhere a server-side event needs to be recorded. Worker logs add jobId.
type LogLevel = "info" | "warn" | "error";

interface LogFields {
  shop?: string;
  requestId?: string;
  jobId?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  });

  if (level === "error") {
    console.error(line);
  } else {
    console.warn(line);
  }
}

export const logger = {
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
};
