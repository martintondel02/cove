/**
 * Spawning external processes, safely.
 *
 * ffmpeg and ffprobe are invoked with **argument arrays**, never a shell string.
 * Media files are untrusted input — filenames derived from user uploads, and
 * metadata inside the file itself — so shell interpolation here would be a
 * straightforward command-injection hole. There is no `shell: true` in this file
 * and there should never be one.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Kill the process after this long. Encoding is unbounded by default. */
  readonly timeoutMs?: number;
  /** Receives stderr incrementally, for progress parsing. */
  readonly onStderr?: (chunk: string) => void;
  readonly signal?: AbortSignal;
  /** Extra environment for the child. */
  readonly env?: Record<string, string>;
  /**
   * Working directory for the child.
   *
   * Required in practice by the encoder: the HLS output patterns are relative
   * (`v%v/index.m3u8`), so the worker sets this to the job's scratch directory
   * rather than building absolute paths for every segment.
   */
  readonly cwd?: string;
}

export class CommandError extends Error {
  override readonly name = "CommandError";
  readonly command: string;
  readonly code: number | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, stderr: string, cause?: unknown) {
    // Keep the tail of stderr: ffmpeg's actual explanation is always at the end,
    // and the first hundred lines are a build-configuration banner nobody reads.
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    super(`\`${command}\` exited with ${code ?? "no status"}.\n${tail}`, { cause });
    this.command = command;
    this.code = code;
    this.stderr = stderr;
  }
}

/** Run a command and resolve with its output, regardless of exit code. */
export function run(
  bin: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      // Never a shell. `args` is an array for exactly this reason.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new CommandError(`${bin} (aborted)`, null, stderr)));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new CommandError(
              `${bin} (timed out after ${options.timeoutMs}ms)`,
              null,
              stderr,
            ),
          ),
        );
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", (error) => {
      finish(() => reject(new CommandError(bin, null, stderr, error)));
    });

    child.on("close", (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });
  });
}

/** Run a command and throw `CommandError` unless it exits 0. */
export async function runOrThrow(
  bin: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(bin, args, options);
  if (result.code !== 0) {
    throw new CommandError(`${bin} ${args.join(" ")}`, result.code, result.stderr);
  }
  return result;
}

/** True when the binary exists and answers `-version` (or any probe args). */
export async function binaryAvailable(bin: string): Promise<boolean> {
  try {
    const result = await run(bin, ["-version"], { timeoutMs: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
