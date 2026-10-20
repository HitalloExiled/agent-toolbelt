/**
 * sandbox — delegate risky work to a disposable container.
 *
 * Thin wrapper over the global `opencode-sb` CLI (opencode-sandbox). Read the
 * `sandbox` skill before delegating: it says *when* to delegate and the prompt
 * contract.
 *
 * The sandbox does not see the host filesystem: input only via `copy_in`.
 * /workspace/out is the user's artifact drop (downloads, builds, screenshots),
 * not a channel: the host agent reads the final answer, never that directory.
 * Internet goes through a proxy that logs everything (auditable via
 * sandbox_logs) or is cut with `sealed`.
 */

import { tool } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Run = { code: number; stdout: string; stderr: string };

/** Resolve the binary: $SANDBOX_BIN > ~/.local/bin/opencode-sb > PATH. */
function sbCommand(): string {
  if (process.env.SANDBOX_BIN) return process.env.SANDBOX_BIN;
  const local = join(homedir(), ".local", "bin", "opencode-sb");
  if (existsSync(local)) return local;
  return "opencode-sb";
}

/**
 * The sandbox project's runs/ directory (agent-toolbelt/sandbox/runs),
 * resolved through the CLI's realpath
 * (~/.local/bin/opencode-sb -> <repo>/sandbox/opencode-sandboxed). Null when
 * the CLI comes from PATH and is not a symlink.
 */
function runsDir(): string | null {
  try {
    return join(dirname(realpathSync(sbCommand())), "runs");
  } catch {
    return null;
  }
}

function spawnCli(
  args: string[],
  input: string | undefined,
  timeoutMs: number,
): Promise<Run> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(sbCommand(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          DOCKER_HOST: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
        },
      });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : undefined;

    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) =>
      resolve({
        code: 127,
        stdout,
        stderr:
          stderr +
          `\ncould not run '${sbCommand()}': ${err.message}\n` +
          "install the sandbox (sandbox/ in the agent-toolbelt repo) or set $SANDBOX_BIN.",
      }),
    );
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code ?? -1,
        stdout,
        stderr: timedOut
          ? stderr + `\n[agent-toolbelt] host budget exhausted (${timeoutMs} ms)`
          : stderr,
      });
    });
    child.stdin?.end(input ?? "");
  });
}

/** Last `text` event of result.json — the sandbox agent's final answer. */
function finalAnswer(runDir: string): string | null {
  const path = join(runDir, "result.json");
  if (!existsSync(path)) return null;
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "text" && typeof event?.part?.text === "string") {
        return event.part.text;
      }
    } catch {
      /* partial line (interrupted execution) — ignore */
    }
  }
  return null;
}

/** User artifact dir (SANDBOX_OUT_ROOT/<run-id>) recorded by run.sh. */
function readHostOut(runDir: string): string | null {
  try {
    const p = readFileSync(join(runDir, "hostout"), "utf8").trim();
    return p || null;
  } catch {
    return null;
  }
}

function render(run: Run): string {
  const out = run.stdout.trim();
  const err = run.stderr.trim();
  if (run.code === 0) return err ? `${out}\n${err}` : out;
  return [out, err, `(exit ${run.code})`].filter(Boolean).join("\n");
}

export const run = tool({
  description:
    "Run a task in a disposable Docker sandbox (ephemeral OpenCode, no access " +
    "to the host filesystem) and return the final answer and exit code. " +
    "BLOCKING: can take minutes. Use for risky work (installing/" +
    "testing packages, running untrusted code, destructive commands, suspicious " +
    "input, dubious internet sources). The prompt must be a self-contained " +
    "execution brief: the agent starts with /workspace empty. Prefer a free " +
    "model; fall back to local (see the sandbox skill's Model selection). After " +
    "any task, audit the network with sandbox_logs. The final answer is the " +
    "only result channel: never ask the sandbox to put its answer in " +
    "/workspace/out, and never read or list that directory (it is the user's " +
    "artifact drop, under SANDBOX_OUT_ROOT). If a run or session is ALREADY " +
    "in progress, use sandbox_steer instead of launching another run.",
  args: {
    prompt: tool.schema
      .string()
      .describe(
        "Complete, self-contained execution brief. The result must be in the " +
          "final message; /workspace/out is only for files the user asked to collect.",
      ),
    model: tool.schema
      .string()
      .optional()
      .describe(
        "Sandbox model ref. Prefer 'opencode/deepseek-v4.1-flash-free' (free; " +
          "needs egress, so NOT with sealed), 'llama.cpp/qwen3.8-gguf-single192' " +
          "for large context, 'llama.cpp/qwen3.8-gguf-duo128' or '...quad' for " +
          "parallel agents. Omit to let the sandbox pick the mode-aware default.",
      ),
    copy_in: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Host paths to copy into /workspace (the only input channel)."),
    sealed: tool.schema
      .boolean()
      .optional()
      .describe(
        "Cut the internet entirely. Use with untrusted input or to guarantee " +
          "no exfiltration. Local models only (free needs egress).",
      ),
    timeout: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in seconds inside the sandbox (CLI default: 1800). 124 = timed out."),
    cpus: tool.schema.number().int().positive().optional().describe("Container CPU limit."),
    mem: tool.schema.string().optional().describe("Memory limit (e.g. '8g')."),
    title: tool.schema.string().optional().describe("Session title in the sandbox."),
  },
  async execute(args) {
    const timeout = args.timeout ?? 1800;
    const argv = ["task", "--prompt-file", "-"];
    if (args.model) argv.push("--model", args.model);
    if (args.title) argv.push("--title", args.title);
    if (args.timeout) argv.push("--timeout", String(args.timeout));
    if (args.cpus) argv.push("--cpus", String(args.cpus));
    if (args.mem) argv.push("--mem", args.mem);
    for (const path of args.copy_in ?? []) argv.push("--copy-in", path);
    if (args.sealed) argv.push("--sealed");

    // Host budget > sandbox timeout, so the 124 comes from the sandbox itself.
    const run = await spawnCli(argv, args.prompt, timeout * 1000 + 180_000);

    const match = /task (run-[A-Za-z0-9-]+)/.exec(run.stderr);
    const runId = match?.[1] ?? null;

    const lines: string[] = [];
    if (run.code === 124) {
      lines.push("⏱️  timeout — inconclusive result (do not treat as a code failure).");
    }
    lines.push(render(run));

    let answer: string | null = null;
    const root = runsDir();
    let hostOut: string | null = null;
    if (runId && root) {
      const dir = join(root, runId);
      answer = finalAnswer(dir);
      hostOut = readHostOut(dir);
      if (answer) {
        lines.push("", "— final answer (result.json) —", answer);
      }
      lines.push("", `run dir: ${dir}/`);
      if (hostOut) {
        lines.push(`user artifact drop: ${hostOut}/ (for the user; do not read)`);
      }
      if (run.code !== 0 && !existsSync(join(dir, "proxy.log"))) {
        lines.push("proxy.log absent (sealed run, or no network requests)");
      }
    }

    return {
      title: runId ? `sandbox_run ${runId} (exit ${run.code})` : `sandbox_run (exit ${run.code})`,
      output: lines.filter((l) => l !== undefined).join("\n"),
      metadata: { run_id: runId, exit_code: run.code, host_out: hostOut, answer },
    };
  },
});

export const steer = tool({
  description:
    "Steer a sandbox run or session that is ALREADY in progress. Use this " +
    "instead of starting another sandbox_run: re-running with a reworded prompt " +
    "duplicates work, loses the context the agent built and can corrupt shared " +
    "output. delivery='steer' (default) injects the message into the current " +
    "turn; 'queue' waits until the turn ends; interrupt=true stops the current " +
    "step so the agent sees the message immediately. Target the long-lived " +
    "session (omit session/run_id) or a running task with run_id. If several " +
    "sessions are running, it refuses and lists them with (running)/(idle).",
  args: {
    message: tool.schema
      .string()
      .describe("The correction or added instruction, sent to the running agent."),
    delivery: tool.schema
      .enum(["steer", "queue"])
      .optional()
      .describe(
        "'steer' (default): inject now, mid-turn. 'queue': deliver after the current turn.",
      ),
    interrupt: tool.schema
      .boolean()
      .optional()
      .describe("Stop the current step before the agent reads the message (redirect a wrong path)."),
    session: tool.schema
      .string()
      .optional()
      .describe("Session id (ses_...) when more than one exists; default: the running one."),
    run_id: tool.schema
      .string()
      .optional()
      .describe("Target a running detached task (run-...) instead of the session."),
  },
  async execute(args) {
    const argv = ["steer"];
    if (args.run_id) argv.push("--run", args.run_id);
    if (args.session) argv.push("--session", args.session);
    if (args.delivery === "queue") argv.push("--queue");
    if (args.interrupt) argv.push("--interrupt");
    argv.push("--", args.message);
    const run = await spawnCli(argv, undefined, 60_000);
    return {
      title: `sandbox_steer${args.run_id ? ` ${args.run_id}` : ""}${args.session ? ` ${args.session}` : ""}`,
      output: render(run),
      metadata: {
        run_id: args.run_id ?? null,
        session: args.session ?? null,
        delivery: args.delivery ?? "steer",
        interrupt: args.interrupt ?? false,
        exit: run.code,
      },
    };
  },
});

export const peek = tool({
  description:
    "Bounded snapshot of a sandbox run or of the long-lived session: status and " +
    "only the last N parts (truncated). This is the agent's view — never call " +
    "watch (unbounded). Poll a detached run with it, then steer if the trajectory " +
    "is wrong instead of starting another run.",
  args: {
    run_id: tool.schema
      .string()
      .optional()
      .describe("Run id (e.g. 'run-20261017T150656Z-6816'). Omit = newest running run."),
    session: tool.schema
      .boolean()
      .optional()
      .describe("Peek the long-lived session instead of a run."),
    lines: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("How many trailing parts to show (default 12)."),
  },
  async execute(args) {
    const argv = ["peek"];
    if (args.session) argv.push("--session");
    if (!args.session && args.run_id) argv.push(args.run_id);
    if (args.lines) argv.push("-n", String(args.lines));
    const run = await spawnCli(argv, undefined, 60_000);
    return {
      title: args.session ? "sandbox_peek (session)" : `sandbox_peek ${args.run_id ?? "(newest)"}`,
      output: render(run),
      metadata: { run_id: args.run_id ?? null, session: args.session ?? false, exit: run.code },
    };
  },
});

export const logs = tool({
  description:
    "Network audit of a sandbox run: shows proxy.log (every internet request, " +
    "domain/URL). Without run_id, shows the session proxy's live log. ALWAYS " +
    "use after a sandbox_run that had network, before trusting the result.",
  args: {
    run_id: tool.schema
      .string()
      .optional()
      .describe("Run id (e.g. 'run-20261017T150656Z-6816'). Omit = long-lived session proxy."),
  },
  async execute(args) {
    const argv = args.run_id ? ["logs", args.run_id] : ["logs"];
    const run = await spawnCli(argv, undefined, 60_000);
    return {
      title: args.run_id ? `sandbox_logs ${args.run_id}` : "sandbox_logs (session)",
      output: render(run),
      metadata: { run_id: args.run_id ?? null, exit: run.code },
    };
  },
});

export const status = tool({
  description:
    "Sandbox state: session, proxy and relay containers, plus which session is " +
    "currently running a turn (idle/running). Check it before steering.",
  args: {},
  async execute() {
    const run = await spawnCli(["status"], undefined, 60_000);
    return {
      title: "sandbox_status",
      output: render(run),
      metadata: { exit: run.code },
    };
  },
});
