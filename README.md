# agent-toolbelt

Tools e skills do agente, mais o **bootstrap de máquina** que os liga ao
OpenCode.

Três subsistemas:

- **`notes`** — memória de longa duração (SQLite + FTS5 opcional), exposta como
  CLI global `notes` e como as tools `notes_*`.
- **`sandbox`** — delegação de trabalho com risco para um container Docker
  descartável, via as tools `sandbox_*` e o CLI `opencode-sb`.
- **`agent-toolbelt` (plugin)** — captura resumos de compactação, injeta o
  estado do repo e o handoff da sessão anterior, e permite busca cross-sessão
  em resumos e conversas passadas. Veja [Plugin: agent-toolbelt](#plugin-agent-toolbelt).

O conteúdo (`tools/`, `skills/`, `memory/`, `sandbox/`, `plugins/`) é genérico;
o acoplamento com o OpenCode vive só no `setup.sh`. Trocar de harness =
reescrever o `setup.sh`.

## Layout

```
agent-toolbelt/
├── setup.sh            # links + banco + sandbox (daemon, guard, imagens, smoke)
├── memory/
│   ├── notes.py        # o CLI (stdlib puro: sqlite3); é o alvo de ~/.local/bin/notes
│   ├── schema.sql      # schema base (v1), idempotente
│   ├── schema_fts.sql  # camada FTS5 (opcional)
│   └── migrations/     # NNN_*.sql para v2+
├── tools/
│   ├── notes.ts
│   └── sandbox.ts
├── plugins/
│   └── toolbelt/        # plugin OpenCode V2: resumos, injeção de contexto, busca
├── sandbox/
│   ├── setup.sh        # expõe opencode-sb/opencode-sandboxed no PATH
│   ├── run.sh          # orquestrador (task/steer/watch/peek/status/up/down/…)
│   ├── opencode-sandboxed  # CLI global (opencode-sb)
│   ├── Dockerfile, proxy/, relay/
│   ├── host-firewall.sh    # guard container → serviços do host
│   ├── models.conf         # listas de preferência de modelo
│   └── README.md
└── skills/
    ├── notes/SKILL.md
    └── sandbox/SKILL.md
```

## Setup

```bash
./setup.sh                 # configura tudo (inclui build + smoke do sandbox)
./setup.sh --check         # só diagnostica (exit 1 se faltar algo)
./setup.sh --remove        # remove os links (nunca toca nos dados nem no firewall)
./setup.sh --prefix DIR    # configura sob DIR (teste/portátil; sem sandbox)
./setup.sh --no-sandbox    # só memória/skills/tools (sem docker/root)
./setup.sh --no-smoke      # prepara o sandbox sem chamar modelo nenhum
./setup.sh --rebuild       # reconstrói as imagens do sandbox
```

O que o `setup.sh` faz, em ordem:

| Passo | Efeito |
|---|---|
| plugin (`@opencode-ai/plugin`) | garante a dependência npm resolvível a partir do repo (npm, ou symlink do config do OpenCode) — usada pelas tools legadas `notes_*`/`sandbox_*` |
| memória | symlink `~/.local/bin/notes` → `memory/notes.py`; migra o banco legado, se existir |
| skills | symlink `skills/<id>/SKILL.md` → `~/.config/opencode/skills/<id>/SKILL.md` |
| tools | symlink `tools/*.ts` → `~/.config/opencode/tools/` |
| plugin `agent-toolbelt` | symlink `plugins/toolbelt/` → `~/.config/opencode/plugins/toolbelt` (resumos, injeção de contexto, busca) |
| sandbox | daemon docker → CLI `opencode-sb` → guard de firewall → imagens/rede → self-test → tarefa de fumaça |
| verificação | `notes init`, `notes doctor`, estado do sandbox, PATH |

É **idempotente**: rodar de novo só confere e repete o smoke. A primeira execução
pede `sudo` uma vez (subir o daemon e instalar o guard). Sem terminal/sudo, use
`--no-sandbox` e rode os comandos privilegiados manualmente — o script imprime
quais são.

Arquivos reais que estejam no caminho são **movidos para backup**
(`*.bak-<timestamp>`), nunca apagados.

## Máquina zerada: o que é criado, quando

O banco e o schema são criados sob demanda: toda invocação do CLI roda
`init_db()` antes de tocar nos dados.

```
$XDG_DATA_HOME/opencode/memory/notes.db     # banco (estado; nunca versionado)
```

| Objeto | Origem |
|---|---|
| banco | `init_db()` |
| `notes` + índices | `schema.sql` |
| `notes_fts` + shadow tables + triggers | `schema_fts.sql` (só se houver FTS5) |
| `note_revisions` e migrações `≥ 2` | `migrations/NNN_*.sql` por `user_version` |
| imagens, rede e relay do sandbox | `sandbox/run.sh up` |
| unit do firewall | `sandbox/host-firewall.sh install-unit` |

**Degradação:** sem FTS5, o CLI avisa e a busca cai para `LIKE`. `notes doctor`
reporta isso.

### Backup

```bash
notes export ~/notes-backup.json   # ou '-' para stdout
notes import ~/notes-backup.json   # append, ignorando duplicadas
```

## CLI e tools

O contrato completo de cada subsistema está nas skills (`skills/notes` e
`skills/sandbox`); aqui vai só o mapa.

| Origem | O que oferece |
|---|---|
| `notes add/update/confirm/dispute/retract/history/restore/view/search/list/doctor` | memória (detalhes em `skills/notes/SKILL.md`) |
| `opencode-sb task/steer/peek/logs/status/…` | sandbox (detalhes em `skills/sandbox/SKILL.md`) |
| `notes_*` | tools tipadas sobre o CLI; `notes_add` **recusa** `#problem` sem Sintoma/Causa/Solução |
| `sandbox_run/steer/peek/logs/status` | tools tipadas sobre o CLI; execução por `argv`, sem shell |

O canal de retorno do sandbox é a **resposta final** (texto). `/workspace/out` é
o drop de artefatos do **usuário** — o agente host nunca lê esse diretório.

### Permissões (opcional)

Se quiser uma allow-list de skills no config do OpenCode:

```jsonc
"permissions": [
  { "action": "skill", "resource": "*",        "effect": "deny"  },
  { "action": "skill", "resource": "notes",    "effect": "allow" },
  { "action": "skill", "resource": "sandbox",  "effect": "allow" }
]
```

## Plugin: agent-toolbelt

Plugin único (`plugins/toolbelt/`, id `agent-toolbelt`) para o OpenCode V2.
Carregado automaticamente como pacote local em `~/.config/opencode/plugins/toolbelt`
(link criado pelo `setup.sh`). Três funções:

1. **Captura resumos de compactação.** Toda vez que uma sessão é compactada, o
   corpo completo do resumo (Objective, Requirements, Decisions, Work State,
   Next Move, Relevant Files, Important Context) é salvo como um arquivo
   Markdown, um por compactação. Nenhuma transcript é guardada — só o resumo
   que o próprio OpenCode já produziu.
2. **Injeta contexto no início da sessão.** No primeiro turno de uma sessão
   (e de novo se o projeto mudar), o plugin injeta um bloco
   `<toolbelt-context>` com: repositório, branch e último commit (o status do
   working tree fica **fora** do bloco, para não invalidar o cache de prefixo
   do servidor a cada edição — peça o estado atual sob demanda pela ferramenta
   `toolbelt`) e o handoff da sessão anterior do mesmo projeto — apenas as
   seções Objective/Next Move, marcadas como *dados não confiáveis* (o corpo
   completo do resumo nunca entra no system prompt; use `toolbelt_summaries`
   para ler). Isso nunca é persistido — é recalculado a cada injeção.
3. **Permite busca cross-sessão.** Um índice derivado (SQLite FTS5, com
   fallback `LIKE` e, por último, JSON) guarda apenas texto de usuário, texto
   de assistente e resumos — nunca reasoning, nunca chamadas de tool. O
   backfill é preguiçoso e incremental: só acontece quando alguém busca, e só
   processa sessões/mensagens novas desde a última vez. `scope=all` busca o
   que já está indexado + todos os resumos em disco; para indexar todos os
   projetos manualmente, use `action=index-all` (ou `/index-all`).

### Onde os dados ficam

```
$XDG_DATA_HOME/agent-toolbelt/
├── compactions/<projectID>/<timestampUTC>-<messageID>.md   # resumos, um por compactação
├── index.db          # índice FTS5 derivado (ou index.json sem SQLite)
```

`projectID` é o identificador de projeto do próprio OpenCode
(`session.projectID`); sessões sem projeto caem em `global`. Nada é
versionado no repo nem escrito dentro dele.

### Tools (read-only, com escopo de projeto por padrão)

| Tool | Para quê |
|---|---|
| `toolbelt_summaries` | listar/buscar/ler resumos de compactação (`detail=brief\|full\|sections`) + estado do repo (`action=repo`) |
| `toolbelt_search` | buscar no índice derivado (resumos + texto de usuário/assistente); `scope=project\|all`; `action=index-all` indexa todos os projetos manualmente (`rebuild=true` para rebuild completo) |
| `toolbelt_history` | inspecionar a timeline completa de uma sessão (listar sessões, ler página, buscar, buscar uma mensagem); tool calls e reasoning só entram com `includeTools`/`includeReasoning` explícitos; sessões de outro projeto exigem `scope=all` |

### Comandos

`/summaries`, `/summary [id] [brief|full|sections]`, `/sessions`, `/index`
(força reindex do projeto), `/index-all` (indexa todos os projetos;
`/index-all rebuild` para rebuild completo) e `/repo` (mostra só o estado do
git). Cada um é um atalho que chama as tools acima.

### Variáveis de ambiente

| Variável | Efeito | Default |
|---|---|---|
| `TOOLBELT_DATA_DIR` | raiz de dados do plugin (sobrepõe XDG) | `$XDG_DATA_HOME/agent-toolbelt` |
| `TOOLBELT_SUMMARY_KEEP` | quantos resumos manter por projeto (os mais antigos são podados, do disco e do índice, quando um novo resumo é capturado — nunca na path de leitura) | `20` |
| `TOOLBELT_INJECT_MAX` | teto de bytes do bloco `<toolbelt-context>` injetado | `~6 KB` |
| `TOOLBELT_INDEX_TEXT_MAX` | teto de caracteres de texto indexado por documento | — |
| `TOOLBELT_BACKFILL_SESSIONS` | teto de sessões processadas por backfill | — |
| `TOOLBELT_BACKFILL_MESSAGES` | teto de mensagens processadas por sessão no backfill | — |

### Privacidade e remoção

Tudo fica fora do repo, em `$XDG_DATA_HOME/agent-toolbelt/` (permissões
`0700`/`0600`). `./setup.sh --remove` remove só o symlink do plugin — nunca
apaga resumos nem o índice. Para apagar os dados de fato:

```bash
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/agent-toolbelt"
```

Para desativar sem remover nada, apague o link
`~/.config/opencode/plugins/toolbelt` (ou rode `./setup.sh --remove`) e
reinicie o OpenCode.

## Desenvolvimento

```bash
npm install        # devDeps: typescript, @types/node, @opencode-ai/plugin, @opencode/plugin, @opencode/client, @opencode/schema
npm run typecheck
npm test           # suite do plugin (bun test, plugins/toolbelt/test)
```

Smoke do CLI sem configurar a máquina:

```bash
NOTES_DB=/tmp/notes-test.db python3 memory/notes.py doctor
NOTES_DB=/tmp/notes-test.db python3 memory/notes.py add "#general" "t" "tag" "conteudo"
```

Teste do `setup.sh` sem tocar na máquina:

```bash
./setup.sh --prefix /tmp/atb-test
```

## Adicionando um componente

1. Tool: crie `tools/<nome>.ts` exportando `tool({...})`; export nomeado vira
   `<nome>_<export>`. Rode `npm run typecheck`.
2. Skill: crie `skills/<id>/SKILL.md` com frontmatter `name`/`description`.
3. `./setup.sh` já linka tudo que estiver nessas pastas.
