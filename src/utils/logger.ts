export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function debug(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.DEBUG) {
    console.log(`[${timestamp()}] [DEBUG] [${tag}] ${msg}`, data ?? "");
  }
}

export function info(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.INFO) {
    console.log(`[${timestamp()}] [INFO] [${tag}] ${msg}`, data ?? "");
  }
}

export function warn(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.WARN) {
    console.warn(`[${timestamp()}] [WARN] [${tag}] ${msg}`, data ?? "");
  }
}

export function error(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.ERROR) {
    console.error(`[${timestamp()}] [ERROR] [${tag}] ${msg}`, data ?? "");
  }
}
