/**
 * sandbox — delegacao de trabalho com risco para um container descartavel.
 *
 * Wrapper sobre o CLI global `opencode-sb` (opencode-sandbox). Leia a skill
 * `sandbox` antes de delegar: ela diz *quando* delegar e o contrato de prompt.
 *
 * O sandbox nao ve o filesystem do host: entrada apenas por `copy_in`, saida
 * apenas pelo que o agente escrever em /workspace/out (retornado em `out/`).
 * A internet passa por um proxy que registra tudo (auditavel via sandbox_logs)
 * ou e cortada com `sealed`.
 */

import { tool } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Run = { code: number; stdout: string; stderr: string };

/** Resolve o binario: $SANDBOX_BIN > ~/.local/bin/opencode-sb > PATH. */
function sbCommand(): string {
  if (process.env.SANDBOX_BIN) return process.env.SANDBOX_BIN;
  const local = join(homedir(), ".local", "bin", "opencode-sb");
  if (existsSync(local)) return local;
  return "opencode-sb";
}

/**
 * Diretorio runs/ do projeto opencode-sandbox, resolvido pelo realpath do CLI
 * (~/.local/bin/opencode-sb -> <repo>/opencode-sandboxed). Null se o CLI vem
 * so do PATH e nao e um symlink.
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
          `\nnao foi possivel executar '${sbCommand()}': ${err.message}\n` +
          "instale o opencode-sandbox (install.sh do repo) ou ajuste $SANDBOX_BIN.",
      }),
    );
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code ?? -1,
        stdout,
        stderr: timedOut
          ? stderr + `\n[agent-toolbelt] orcamento do host esgotado (${timeoutMs} ms)`
          : stderr,
      });
    });
    child.stdin?.end(input ?? "");
  });
}

/** Ultimo evento `text` de result.json — a resposta final do agente do sandbox. */
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
      /* linha parcial (execucao interrompida) — ignora */
    }
  }
  return null;
}

function listOut(runDir: string): string[] {
  try {
    return readdirSync(join(runDir, "out")).sort();
  } catch {
    return [];
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
    "Executa uma tarefa num sandbox Docker descartavel (OpenCode efemero, sem " +
    "acesso ao filesystem do host) e retorna a resposta final, o exit code e os " +
    "artefatos. BLOQUEANTE: pode levar minutos. Use para trabalho com risco " +
    "(instalar/testar pacotes, rodar codigo nao confiavel, comandos destrutivos, " +
    "entrada suspeita, fontes duvidosas na internet). O prompt deve ser " +
    "autocontido: o agente comeca com /workspace vazio e escreve entregaveis em " +
    "/workspace/out. Sempre passe model. Depois de qualquer tarefa, audite a rede " +
    "com sandbox_logs.",
  args: {
    prompt: tool.schema
      .string()
      .describe(
        "Tarefa completa e autocontida. Instrua o agente a escrever o entregavel " +
          "em /workspace/out/.",
      ),
    model: tool.schema
      .string()
      .optional()
      .describe("Modelo do sandbox (ex.: 'llama.cpp/qwen3.8-gguf-max'). Passe sempre, para determinismo."),
    copy_in: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Caminhos do host a copiar para /workspace (unico canal de entrada)."),
    sealed: tool.schema
      .boolean()
      .optional()
      .describe("Corta a internet por completo. Use com entrada nao confiavel ou para garantir zero exfiltracao."),
    timeout: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout em segundos dentro do sandbox (padrao do CLI: 1800). 124 = estourou."),
    cpus: tool.schema.number().int().positive().optional().describe("Limite de CPUs do container."),
    mem: tool.schema.string().optional().describe("Limite de memoria (ex.: '8g')."),
    title: tool.schema.string().optional().describe("Titulo da sessao no sandbox."),
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

    // Orcamento do host > timeout do sandbox, para o 124 vir do proprio sandbox.
    const run = await spawnCli(argv, args.prompt, timeout * 1000 + 180_000);

    const match = /task (run-[A-Za-z0-9-]+)/.exec(run.stderr);
    const runId = match?.[1] ?? null;

    const lines: string[] = [];
    if (run.code === 124) {
      lines.push("⏱️  timeout — resultado inconclusivo (nao trate como falha do codigo).");
    }
    lines.push(render(run));

    let artifacts: string[] = [];
    let answer: string | null = null;
    const root = runsDir();
    if (runId && root) {
      const dir = join(root, runId);
      answer = finalAnswer(dir);
      artifacts = listOut(dir);
      if (answer) {
        lines.push("", "— resposta final (result.json) —", answer);
      }
      lines.push("", `artefatos: ${dir}/`);
      if (artifacts.length > 0) lines.push(`out/: ${artifacts.join(", ")}`);
      if (run.code !== 0 && !existsSync(join(dir, "proxy.log"))) {
        lines.push("proxy.log ausente (run --sealed, ou nenhuma requisicao de rede)");
      }
    }

    return {
      title: runId ? `sandbox_run ${runId} (exit ${run.code})` : `sandbox_run (exit ${run.code})`,
      output: lines.filter((l) => l !== undefined).join("\n"),
      metadata: { run_id: runId, exit_code: run.code, artifacts, answer },
    };
  },
});

export const logs = tool({
  description:
    "Auditoria de rede de um sandbox run: mostra o proxy.log (todas as requisicoes " +
    "de internet, dominio/URL). Sem run_id, mostra o log ao vivo do proxy da sessao. " +
    "Use SEMPRE depois de um sandbox_run que teve rede, antes de confiar no resultado.",
  args: {
    run_id: tool.schema
      .string()
      .optional()
      .describe("Id do run (ex.: 'run-20261017T150656Z-6816'). Omitir = proxy da sessao longeva."),
  },
  async execute(args) {
    const argv = args.run_id ? ["logs", args.run_id] : ["logs"];
    const run = await spawnCli(argv, undefined, 60_000);
    return {
      title: args.run_id ? `sandbox_logs ${args.run_id}` : "sandbox_logs (sessao)",
      output: render(run),
      metadata: { run_id: args.run_id ?? null, exit: run.code },
    };
  },
});

export const status = tool({
  description:
    "Estado do sandbox: container de sessao, proxy e relay (running/stopped).",
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
