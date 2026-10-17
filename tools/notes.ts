/**
 * notes — ferramentas de memoria de longa duracao.
 *
 * Wrapper fino e tipado sobre o CLI global `notes` (alias `notes`), que vive
 * em ../memory/notes.py dentro deste repo. O wrapper NAO expoe nenhuma
 * operacao destrutiva: apenas add / search / list / doctor.
 *
 * Seguranca:
 *  - execucao via spawn com argv (sem shell) => o conteudo da nota nunca e
 *    interpretado; aspas, `;`, `$(...)`, emoji e quebras de linha sao literais;
 *  - o guardrail de `#problem` recusa a gravacao sem Sintoma/Causa/Solucao,
 *    transformando a convencao da skill em algo que a ferramenta *garante*.
 */

import { tool } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CATEGORIES = [
  "problem",
  "decision",
  "config",
  "snippet",
  "architecture",
  "general",
] as const;

type Run = { code: number; stdout: string; stderr: string };

/** Resolve o binario: $NOTES_BIN > ~/.local/bin/notes > PATH. */
function nbCommand(): string {
  if (process.env.NOTES_BIN) return process.env.NOTES_BIN;
  const local = join(homedir(), ".local", "bin", "notes");
  if (existsSync(local)) return local;
  return "notes";
}

function runNb(args: string[], input?: string): Promise<Run> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nbCommand(), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) =>
      resolve({
        code: 127,
        stdout,
        stderr:
          stderr +
          `\nnao foi possivel executar '${nbCommand()}': ${err.message}\n` +
          "instale com ./install.sh no repo agent-toolbelt (cria o symlink em ~/.local/bin).",
      }),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin?.end(input ?? "");
  });
}

function render(run: Run): string {
  const out = run.stdout.trim();
  const err = run.stderr.trim();
  if (run.code === 0) return err ? `${out}\n${err}` : out;
  return [out, err, `(exit ${run.code})`].filter(Boolean).join("\n");
}

/** Normaliza para comparacao: sem acentos, minusculo. */
function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Secoes obrigatorias ausentes numa nota #problem. */
function missingProblemSections(content: string): string[] {
  const text = norm(content);
  const required: Array<[string, string]> = [
    ["Sintoma", "sintoma"],
    ["Causa", "causa"],
    ["Solução", "solucao"],
  ];
  return required.filter(([, needle]) => !text.includes(needle)).map(([label]) => label);
}

export const add = tool({
  description:
    "Grava uma nota na memoria de longa duracao (notes). Use para decisoes, " +
    "configuracoes nao obvias, snippets e — principalmente — problemas resolvidos. " +
    "Regra: se category=problem, o content DEVE conter Sintoma, Causa e Solucao " +
    "(a ferramenta recusa a gravacao se faltar algum). Antes de gravar, busque " +
    "com notes_search para nao duplicar.",
  args: {
    category: tool.schema
      .enum(CATEGORIES)
      .describe("Categoria da nota. Use 'problem' para problema resolvido."),
    title: tool.schema
      .string()
      .describe("Titulo curto e especifico. Para 'problem', descreva o sintoma."),
    content: tool.schema
      .string()
      .describe(
        "Conteudo escrito para quem nao viu a conversa. Se category=problem: " +
          "Sintoma: ... | Causa: <raiz> | Solucao: <reproduzivel> | Arquivos: ...",
      ),
    tags: tool.schema
      .string()
      .optional()
      .describe("Palavras-chave separadas por espaco, sem '#' (ex.: 'selinux module')."),
  },
  async execute(args) {
    const category = args.category;
    const content = args.content ?? "";
    const tags = args.tags ?? "";

    if (category === "problem") {
      const missing = missingProblemSections(content);
      if (missing.length > 0) {
        return {
          title: "notes_add: recusado (nota #problem incompleta)",
          output:
            `❌ Nota NAO gravada. Falta em content: ${missing.join(", ")}.\n\n` +
            "A convencao exige causa raiz e solucao reproduzivel, nao o sintoma repetido.\n" +
            "Reescreva o content neste formato e chame de novo:\n" +
            "Sintoma: <o que se observava / mensagem de erro> | " +
            "Causa: <motivo raiz> | Solucao: <comando ou passos exatos> | " +
            "Arquivos: <caminhos tocados, opcional>",
          metadata: { rejected: true, missing },
        };
      }
    }

    if (!args.title.trim()) {
      return { title: "notes_add: recusado", output: "❌ title vazio." };
    }

    const run = await runNb(["add", `#${category}`, args.title, tags, content]);
    return {
      title: `notes_add: ${category} — ${args.title}`,
      output: render(run),
      metadata: { category, exit: run.code },
    };
  },
});

export const search = tool({
  description:
    "Busca na memoria de longa duracao. Sem 'query', lista as notas mais recentes. " +
    "Multiplas palavras sao combinadas com OR (casa qualquer uma). Use ANTES de " +
    "trabalhar num projeto com historico e antes de gravar uma nota nova.",
  args: {
    query: tool.schema
      .string()
      .optional()
      .describe("Termo(s) de busca. Omitir ou deixar vazio equivale a listar as ultimas notas."),
    limit: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximo de notas a retornar (padrao: 10)."),
  },
  async execute(args) {
    const query = (args.query ?? "").trim();
    const limit = args.limit ?? 10;
    const run = query
      ? await runNb(["search", query, String(limit)])
      : await runNb(["list", String(limit)]);
    return {
      title: query ? `notes_search: ${query}` : "notes_search: ultimas notas",
      output: render(run),
      metadata: { query, limit, exit: run.code },
    };
  },
});

export const doctor = tool({
  description:
    "Diagnostico do subsistema de memoria: python/sqlite, disponibilidade de FTS5 " +
    "(busca full-text; se ausente, o CLI degrada para LIKE), caminho e versao do " +
    "schema do banco, contagem de notas e sincronia do indice. Use quando uma " +
    "busca/gravacao falhar ou para saber se a maquina esta pronta.",
  args: {},
  async execute() {
    const run = await runNb(["doctor"]);
    return {
      title: "notes_doctor",
      output: render(run),
      metadata: { exit: run.code },
    };
  },
});
