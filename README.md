# agent-toolbelt

Tools e skills do agente, mais o **bootstrap de máquina** que os instala.
Nasceu de dois subsistemas:

- **`notes`** — memória de longa duração do agente (SQLite + FTS5 opcional),
  exposta como CLI global `notes` e como as tools `notes_add` /
  `notes_update` / `notes_confirm` / `notes_dispute` / `notes_retract` /
  `notes_history` / `notes_restore` / `notes_view` / `notes_search` / `notes_doctor`.
- **`sandbox`** — delegação de trabalho com risco para um container Docker
  descartável, via as tools `sandbox_run` / `sandbox_steer` / `sandbox_peek` /
  `sandbox_logs` / `sandbox_status` (wrapper do CLI `opencode-sb`, em
  `sandbox/`).

Tudo é **conteúdo genérico** (`tools/`, `skills/`, `memory/`); o acoplamento
com o OpenCode vive só no `install.sh`. Trocar de harness = reescrever o
`install.sh`.

## Layout

```
agent-toolbelt/
├── install.sh            # symlinks + migração de banco + verificação
├── memory/
│   ├── notes.py          # o CLI (stdlib puro: sqlite3)
│   ├── notes             # wrapper bash (executa notes.py)
│   ├── schema.sql        # schema base (v1), idempotente
│   ├── schema_fts.sql    # camada FTS5 (opcional)
│   └── migrations/       # NNN_*.sql para v2+
├── tools/
│   ├── notes.ts
│   └── sandbox.ts
├── sandbox/                  # sandbox (era o repo opencode-sandbox; agora versionado aqui)
│   ├── run.sh                # orquestrador (task/steer/interrupt/watch/peek/sessions/status/up/down/logs/models/clean)
│   ├── opencode-sandboxed    # CLI global (opencode-sb)
│   ├── Dockerfile, proxy/, relay/
│   ├── models.conf           # listas de preferência de modelo
│   └── README.md, ORCHESTRATION.md
└── skills/
    ├── notes/SKILL.md
    └── sandbox/SKILL.md
```

## Instalação

```bash
./install.sh              # instala tudo
./install.sh --check      # só diagnostica, não altera nada
./install.sh --uninstall  # remove os symlinks (nunca toca nos dados)
./install.sh --prefix DIR # instala sob DIR (teste/portátil)
```

O que o install faz:

| Passo | Efeito |
|---|---|
| plugin | garante `@opencode-ai/plugin` resolvível a partir do repo (npm, ou symlink do config do OpenCode) |
| memória | symlink `~/.local/bin/notes` → `memory/notes`; migra o banco legado, se existir |
| skills | symlink `skills/<id>/SKILL.md` → `~/.config/opencode/skills/<id>/SKILL.md` |
| tools | symlink `tools/*.ts` → `~/.config/opencode/tools/` |
| verificação | roda `notes init`, `notes doctor` e checa `docker` / `opencode-sb` |

Arquivos reais que estejam no caminho são **movidos para backup**
(`*.bak-<timestamp>`), nunca apagados.

## Máquina zerada: o que é criado, quando

**Nada é criado à mão.** O banco e o schema são criados sob demanda: toda
invocação roda `init_db()` antes de tocar nos dados. `notes list` numa máquina
nova já cria tudo.

```
$XDG_DATA_HOME/opencode/memory/notes.db     # banco (estado; nunca versionado)
```

| Objeto | Origem |
|---|---|
| banco | `init_db()` |
| `notes` (tabela) + índices | `schema.sql` |
| `notes_fts` + shadow tables + triggers | `schema_fts.sql` (só se houver FTS5) |
| `user_version` = `SCHEMA_VERSION` (hoje 3) | `SCHEMA_VERSION` em `notes.py` |
| `note_revisions` (histórico de `update`) | `migrations/003_note_revisions.sql` |
| migrações `≥ 2` | `migrations/NNN_*.sql`, aplicadas por `user_version` |

**Degradação:** se o `python3` da máquina não tiver FTS5, o CLI avisa e a busca
cai para `LIKE` — a memória continua funcionando. `notes doctor` reporta isso.

**FTS5 é auto-reparador:** a camada FTS roda em todo init (não só quando a
tabela falta), então bancos antigos ganham os triggers de `UPDATE`/`DELETE`
introduzidos depois. `notes reindex` reconstrói o índice.

### Backup e transporte

O banco é estado local, então não vai para o git. Para levar a memória entre
máquinas:

```bash
notes export ~/notes-backup.json   # ou '-' para stdout
notes import ~/notes-backup.json   # append, ignorando duplicadas
```

## CLI

```bash
notes add "<categoria>" "<título>" "<tags>" "<conteúdo>"
notes update <id> [--title T] [--tags T] [--content C | --content-file F]
                  [--category C]   # ÚLTIMO RECURSO: corrige informação conflitante
notes confirm <id>                 # ✔ reverifiquei: ainda vale (limpa disputa/retração)
notes dispute <id> --why "<motivo>"    # ⚠ suspeita, sem correção ainda: mostrada por último
notes retract <id> [--why "<motivo>"]  # 🚫 lixo/obsoleta: sai do search/list (reversível)
notes history <id> [limite]        # versão atual + revisões (cada `update` guarda uma)
notes restore <id> <rev>           # devolve o conteúdo de uma revisão (nada se perde)
notes view <id>                    # a nota inteira pelo id (alias: show; inclui retratada)
notes search "<termo>" [limite] [--all]  # todas as palavras (AND); sem match, OR
notes list [limite] [--all]        # padrão 10; --all inclui retratadas
notes doctor                       # python/sqlite, FTS5, schema, contagem, confiança
notes init                         # cria/atualiza (idempotente)
notes export [arquivo|-]           # JSON
notes import <arquivo|->           # JSON
notes reindex                      # reconstrói o índice FTS5
```

Categorias: `#problem`, `#decision`, `#config`, `#snippet`, `#architecture`,
`#general`. Tags sem `#`. Variável de ambiente: `NOTES_DB` (caminho do banco).

**Confiança numa nota** (a busca mostra a marca sob a nota; disputadas sempre
ordenam por último):

- `confirm` — li a nota, conferi, ainda vale. É o sinal positivo e barato; limpa
  qualquer disputa/retração. Prefira isso a escrever uma nota "continua valendo".
- `dispute` — desconfio que está errada **e não tenho a correção**. A próxima
  leitura vê o ⚠ com o motivo. Com a correção em mãos, use `update` (que resolve
  a disputa e re-verifica).
- `retract` — lixo/teste/obsoleto: some do search/list sem apagar nada;
  `confirm`/`update` a trazem de volta e `--all` continua mostrando. Deletar
  segue sendo ação só do humano (`wipe`, ver abaixo).

**Histórico de correção.** Todo `update` (e portanto `restore`) guarda o estado
anterior da nota em `note_revisions` **antes** de reescrever: corrigir nunca
perde o texto antigo. `notes history <id>` mostra a versão atual e as anteriores
(`rev #N`); `notes restore <id> <rev>` devolve o conteúdo de uma delas — e como
o restore também é um update, ele snapshota a versão atual primeiro, então dá
para voltar atrás de novo. `export`/`import` carregam o histórico junto.

**Manutenção destrutiva** (`wipe`) existe, mas exige TTY + confirmação
digitada, não tem flag não-interativa, não aparece no help sem TTY e **não é
exposta por nenhuma tool** — é para o humano, no terminal dele.

## Tools

| Tool | O que faz |
|---|---|
| `notes_add` | grava uma nota; **recusa** `#problem` sem Sintoma/Causa/Solução |
| `notes_update` | **último recurso**: corrige uma nota errada/conflitante (re-verifica) |
| `notes_confirm` | ✔ reverifica uma nota lida: ainda vale (limpa disputa/retração) |
| `notes_dispute` | ⚠ marca uma nota como suspeita **sem** reescrevê-la (exige `why`) |
| `notes_retract` | 🚫 esconde lixo/obsoleto do search/list (reversível; nada é apagado) |
| `notes_history` | versão atual + revisões anteriores de uma nota (rev #N) |
| `notes_restore` | devolve o conteúdo de uma revisão (a versão atual é guardada antes) |
| `notes_view` | mostra a nota inteira pelo id, em qualquer estado (retratada incluída, com 🚫) |
| `notes_search` | busca; sem `query`, lista as últimas (disputadas por último; retratadas ocultas) |
| `notes_doctor` | diagnostica memória/schema/FTS5 e o estado de confiança |
| `sandbox_run` | tarefa isolada; devolve a resposta final e o exit code |
| `sandbox_steer` | corrige um run/sessão **em andamento**: injeta, enfileira (`delivery="queue"`) ou interrompe e redireciona (`interrupt=true`) |
| `sandbox_peek` | visão limitada de um run/sessão: status + últimas N partes (nunca `watch`) |
| `sandbox_logs` | audita a rede (`proxy.log`) de um run |
| `sandbox_status` | estado dos containers e do turno ativo (`running`/`idle`) |

O canal de retorno é a **resposta final** (texto). `/workspace/out` é o drop de
artefatos do **usuário** (downloads, builds, screenshots) — o agente host nunca
lê esse diretório nem o usa para receber resultados.

Por que tools e não só a skill: o guardrail de `#problem` **garante** o formato
(a skill só pede), a execução é via `argv` sem shell (conteúdo com aspas, `;`,
`$(...)` ou quebras de linha é literal), e o resultado já vem estruturado.

## Permissões (OpenCode)

As skills ficam sob allow-list no config do OpenCode:

```jsonc
"permissions": [
  { "action": "skill", "resource": "*",        "effect": "deny"  },
  { "action": "skill", "resource": "notes",    "effect": "allow" },
  { "action": "skill", "resource": "sandbox",  "effect": "allow" }
]
```

## Desenvolvimento

```bash
npm install        # devDeps: typescript, @types/node, @opencode-ai/plugin
npm run typecheck
```

Testes de fumaça do CLI (sem instalar nada):

```bash
NOTES_DB=/tmp/notes-test.db python3 memory/notes.py doctor
NOTES_DB=/tmp/notes-test.db python3 memory/notes.py add "#general" "t" "tag" "conteudo"
```

Teste do `install.sh` sem tocar na máquina real:

```bash
./install.sh --prefix /tmp/atb-test
```

## Adicionando um componente

1. Tool: crie `tools/<nome>.ts` exportando `tool({...})`; export nomeado vira
   `<nome>_<export>`. Rode `npm run typecheck`.
2. Skill: crie `skills/<id>/SKILL.md` com frontmatter `name`/`description`.
3. `./install.sh` já symlinka tudo que estiver nessas pastas.
