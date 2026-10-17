---
name: notes
description: Memória de longa duração em SQLite (FTS5) via CLI global `notes` e das tools `notes_add`/`notes_search`/`notes_doctor`. Use para lembrar ou recuperar decisões, configurações, snippets e contexto de projeto de sessões anteriores, e para gravar novas notas — incluindo o registro obrigatório de problemas resolvidos com sintoma, causa e solução. Recorra sempre que o usuário perguntar o que foi decidido/feito antes, pedir contexto anterior, ou antes de trabalhar em projeto com histórico.
metadata:
  audience: any
  opencode/slash: "true"
---

## O que é

Sistema de memória de longa duração baseado em SQLite (+ índice FTS5 quando
disponível), exposto pelo CLI global `notes`. O banco fica em
`~/.local/share/opencode/memory/notes.db` (ou no caminho de `$NOTES_DB`) e —
junto com o schema — é criado sob demanda: uma máquina zerada não precisa de
passo manual nenhum.

Implementação e instalação: repo **`agent-toolbelt`** (seção `memory/`).

## Como usar

**Dentro do OpenCode, prefira as tools** (tipadas, sem shell, com validação):

| Tool | Para que |
|---|---|
| `notes_search` | buscar / listar as últimas notas (sem `query` = listar) |
| `notes_add` | gravar uma nota (valida o formato de `#problem`) |
| `notes_doctor` | diagnosticar memória/schema/FTS5 quando algo falha |

Pelo terminal (ou se as tools não estiverem disponíveis), o CLI equivalente:

```bash
notes search "<termo>" [limite]   # múltiplas palavras = OR (casa qualquer uma)
notes list [limite]               # padrão: 10
notes add "<categoria>" "<título>" "<tags>" "<conteúdo>"
notes doctor                      # diagnóstico
```

## Quando usar

- **Ao iniciar trabalho** num projeto com histórico: busque antes de agir.
- **Ao resolver um problema não-trivial**: registre sintoma → causa → solução
  (seção abaixo). É a regra mais importante da skill.
- **Ao tomar decisões importantes** (arquitetura, trade-offs, configuração não
  óbvia): grave com categoria `#decision`.
- **Ao gerar snippets/configurações reutilizáveis**: `#snippet` / `#config`.
- **Nunca apague nem sobrescreva o banco de memória.** Se o usuário pedir para
  limpar o histórico, oriente-o a rodar a manutenção manualmente no terminal
  dele — não faça isso você mesmo, e não são comandos do CLI expostos aqui.

## Registrar problemas resolvidos (obrigatório)

Sempre que resolver um problema **não-trivial** — bug, erro de configuração,
comportamento inesperado, falha de dependência, regressão — grave uma nota
`#problem` **antes de encerrar a tarefa**. A próxima sessão não deve remedir o
mesmo problema: sua nota é o atalho.

**Conteúdo obrigatório: Sintoma, Causa, Solução.** A tool `notes_add`
**recusa** a gravação de uma nota `#problem` que não tenha as três seções.

```
Sintoma: <o que se observava / mensagem de erro>
Causa: <motivo raiz, não o sintoma>
Solução: <o que resolveu, reproduzível>
Arquivos: <caminhos tocados, opcional>
```

Regras:

- **Causa raiz, não sintoma.** "Faltava `exec` em `/tmp` no mount" é causa;
  "o comando falhava" é sintoma.
- **Solução reproduzível:** o comando ou os passos exatos, não "ajustei a config".
- **Não registre o trivial** (typo seu, dúvida de sintaxe, comando que você
  errou). O critério: se outro agente pode cair no mesmo problema, registre.
- **Antes de gravar, busque.** Se o mesmo problema já está documentado com a
  mesma solução, não duplique.
- Vários problemas resolvidos numa sessão = várias notas, uma por problema.

## Convenções

- **Categorias**: `#problem`, `#decision`, `#config`, `#snippet`,
  `#architecture`, `#general`.
- **Tags**: palavras-chave separadas por espaço, sem `#` (ex.: `selinux module`).
- **Título**: curto e específico — para problemas, descreva o sintoma
  (ex.: "sandbox TUI falha sem exec em /tmp").
- **Conteúdo**: o fato/decisão + o porquê + comandos ou caminhos relevantes.
  Escreva para quem não viu a conversa.

## Backup e transporte

O banco é estado local, não versionado. Para levar a memória entre máquinas
(ou guardar uma cópia):

```bash
notes export ~/notes-backup.json    # ou 'notes export -' para stdout
notes import ~/notes-backup.json    # append, ignorando duplicadas
```

`notes reindex` reconstrói o índice FTS5 se ele sair de sincronia (o `notes doctor`
avisa quando isso acontece).

## Verificação rápida

```bash
notes doctor        # python/sqlite, FTS5, schema, contagem, sincronia do índice
type -a notes       # deve apontar para ~/.local/bin/notes
```

Se `notes` não existir, o wrapper e o schema vivem em `agent-toolbelt/memory/`;
reinstale com `./install.sh` na raiz do repo. Se o `python3` da máquina não
tiver FTS5, o `doctor` avisa e a busca cai para `LIKE` — a memória continua
funcionando.
