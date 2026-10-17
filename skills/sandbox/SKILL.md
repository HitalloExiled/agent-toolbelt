---
name: sandbox
description: Sandbox Docker descartável para delegar tarefas com risco. Use SEMPRE que a tarefa puder afetar a estabilidade do sistema (mexer em pacotes, serviços, kernel, /etc, discos, permissões), executar código/scripts/dependências não confiáveis, rodar comandos destrutivos ou de resultado incerto, processar arquivos potencialmente maliciosos, ou consultar/baixar fontes pouco confiáveis na internet. O sandbox não enxerga o filesystem do host (entrada só por copy_in, saída só por /workspace/out) e a internet passa por um proxy que registra tudo, ou é cortada com sealed. Você (host) atua como orquestrador pelas tools `sandbox_run`/`sandbox_logs`/`sandbox_status` ou pelo CLI global `opencode-sb`. Não use para perguntas simples/read-only que você resolve localmente.
metadata:
  audience: any
  opencode/slash: "true"
---

## O que é

`opencode-sandbox` executa uma instância OpenCode efêmera dentro de um container
Docker descartável. Você delega a tarefa e ela roda isolada do host: **sem acesso
ao seu filesystem**, sem docker.sock, sem capabilities, com egress de rede
controlado. Serve para fazer o trabalho sujo longe da máquina real.

CLI global: `opencode-sb` (alias de `opencode-sandboxed`).
Projeto: repo `opencode-sandbox` — `README.md` e `ORCHESTRATION.md` para a
referência completa.

## Como orquestrar

**Dentro do OpenCode, prefira as tools:**

| Tool | Para que |
|---|---|
| `sandbox_run` | executa a tarefa e devolve resposta final, exit code e artefatos |
| `sandbox_logs` | audita a rede (`proxy.log`) de um run ou da sessão |
| `sandbox_status` | estado dos containers de sessão/proxy/relay |

Equivalente no terminal:

```bash
opencode-sb task --model <ref> --timeout 1800 \
  --prompt "<tarefa autocontida>" [--copy-in <host-path>]... [--sealed]
```

- **Bloqueante**: retorna quando termina ou estoura o `--timeout`.
- **Exit code**: `0` sucesso, `124` timeout (inconclusivo), outro = falha.
- **Sempre passe `--model`** explicitamente, para determinismo.
- De um shell sandboxed, exporte `DOCKER_HOST=unix:///var/run/docker.sock`
  (as tools já fazem isso automaticamente).

### Sessão interativa (trabalho iterativo)

```bash
opencode-sb             # TUI numa sessão longeva
opencode-sb run "msg"   # one-shot na sessão; imprime a resposta
opencode-sb status      # estado de sessão/proxy/relay
opencode-sb down        # destrói a sessão ao terminar
```

Estado da sessão vive em tmpfs até `down`. Prefira `task` para trabalho isolado.

## Isolamento de rede

- **Padrão (egress imposto):** internet **só** pelo proxy que registra tudo.
  Quem não honra `HTTP(S)_PROXY` falha — é o modo de falha pretendido.
- **`--sealed`:** zero internet. Use ao processar entrada não confiável/maliciosa
  ou quando precisar garantir que não há exfiltração.

## Artefatos

Em `runs/<run-id>/` dentro do repo `opencode-sandbox`:

| Arquivo | O que é |
|---|---|
| `result.json` | eventos da execução em JSON (stream); a **resposta final** está no último evento `text` — `sandbox_run` já extrai e devolve |
| `out/` | arquivos escritos em `/workspace/out` (único canal de saída) |
| `proxy.log` | auditoria de **todas** as requisições de internet (domínio/URL). **Não existe em `--sealed`** |
| `stderr.log` | logs do OpenCode no sandbox |

## Regras de prompt

- O agente começa com `/workspace` **vazio** e não vê o host. Seja autocontido.
- Para passar arquivos, use `copy_in` / `--copy-in` (repetível) — caem em
  `/workspace/<nome>`.
- Mande o agente **escrever o entregável em `/workspace/out/`**.
- Prompts longos: `--prompt-file arquivo` (ou `--prompt-file -` para stdin).

## Auditoria (obrigatória antes de confiar)

Depois de qualquer tarefa, leia a resposta final e **revise a rede com
`sandbox_logs` / `proxy.log`** (quando existir, ou seja, fora do `--sealed`)
antes de confiar no resultado — especialmente se a tarefa lidou com entrada não
confiável, para confirmar que nada foi exfiltrado nem veio de fonte inesperada.

## Quando NÃO usar

- Perguntas read-only que você responde localmente (docs, código existente).
- Tarefas que precisam, de fato, tocar arquivos/estado do host — nesse caso
  avise o usuário; a ausência de superfície compartilhada é intencional.

## Nunca

- Não passe segredos do host (tokens, credenciais, `~/.config` além do provider
  gerado) em prompts ou `copy_in`.
- Não presuma que `/workspace` persiste entre tasks — cada `task` é limpo.
- Não monte caminhos do host: a única superfície é `copy_in` (entrada) e `out/`
  (saída).
- Não confie em código/arquivo não confiável sem antes rodar `--sealed` e revisar
  a saída e o log.

## Exemplos

```bash
# 1) Testar um script desconhecido baixado da internet
opencode-sb task --model llama.cpp/qwen3.8-gguf-max --timeout 900 \
  --prompt "Baixe https://exemplo.duvidoso/inst.sh, inspecione o conteúdo e diga
o que ele faz. NÃO execute. Grave o relatório em /workspace/out/analise.md."

# 2) Simular mudança de config do sistema sem tocar no host
opencode-sb task --model llama.cpp/qwen3.8-gguf-max --timeout 900 \
  --copy-in ./meu-sshd_config \
  --prompt "Valide este sshd_config com 'sshd -t' e liste o que quebraria.
Escreva o resultado em /workspace/out/validacao.txt."

# 3) Processar entrada potencialmente maliciosa, sem rede
opencode-sb task --model llama.cpp/qwen3.8-gguf-max --sealed \
  --copy-in ./anexo-suspeito.bin \
  --prompt "Analise o arquivo, identifique formato e IOCs. NÃO execute nada.
Grave em /workspace/out/iocs.json."
```

## Verificação rápida

```bash
opencode-sb help          # lista os comandos
sandbox_status            # (tool) ou: opencode-sb status
opencode-sb clean         # limpa containers órfãos
```

Se `opencode-sb` não existir, instale pelo `install.sh` do repo
`opencode-sandbox`.
