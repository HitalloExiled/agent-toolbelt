# agent-toolbelt

Tools e skills do agente, mais o **bootstrap de máquina** que os liga ao
OpenCode.

Dois subsistemas:

- **`notes`** — memória de longa duração (SQLite + FTS5 opcional), exposta como
  CLI global `notes` e como as tools `notes_*`.
- **`sandbox`** — delegação de trabalho com risco para um container Docker
  descartável, via as tools `sandbox_*` e o CLI `opencode-sb`.

O conteúdo (`tools/`, `skills/`, `memory/`, `sandbox/`) é genérico; o acoplamento
com o OpenCode vive só no `setup.sh`. Trocar de harness = reescrever o
`setup.sh`.

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
| plugin | garante `@opencode-ai/plugin` resolvível a partir do repo (npm, ou symlink do config do OpenCode) |
| memória | symlink `~/.local/bin/notes` → `memory/notes.py`; migra o banco legado, se existir |
| skills | symlink `skills/<id>/SKILL.md` → `~/.config/opencode/skills/<id>/SKILL.md` |
| tools | symlink `tools/*.ts` → `~/.config/opencode/tools/` |
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

## Desenvolvimento

```bash
npm install        # devDeps: typescript, @types/node, @opencode-ai/plugin
npm run typecheck
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
