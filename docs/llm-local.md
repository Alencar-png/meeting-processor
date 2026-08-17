# LLM local com Ollama

O Meeting Processor consegue gerar resumos de duas formas:

| Provedor   | Quando usar                                                  |
|------------|--------------------------------------------------------------|
| `anthropic` | Você quer a melhor qualidade e tem API key da Anthropic.     |
| `local`     | Você quer privacidade total / zero custo / rodar offline.    |

A alternância é feita pela variável de ambiente **`MEETING_LLM_PROVIDER`**.

---

## 1. Instalar o Ollama

**Windows / macOS:** baixe o instalador em <https://ollama.com/download> e
execute. O serviço sobe sozinho em `http://localhost:11434`.

**Linux:**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Verifique:

```bash
ollama --version
curl http://localhost:11434/api/tags
```

---

## 2. Baixar o modelo

O padrão é **`qwen2.5:14b`** — bom equilíbrio entre qualidade e tamanho
(~9 GB), excelente em português e em gerar JSON estruturado.

```bash
ollama pull qwen2.5:14b
```

### Outros modelos suportados

| Modelo            | Tamanho | Observação                                        |
|-------------------|---------|---------------------------------------------------|
| `qwen2.5:7b`      | ~4.7 GB | Mais rápido, qualidade um pouco menor             |
| `qwen2.5:14b`     | ~9 GB   | **Padrão recomendado**                            |
| `qwen2.5:32b`     | ~20 GB  | Próximo de modelos comerciais; precisa GPU forte  |
| `llama3.1:8b`     | ~4.7 GB | Alternativa da Meta, bom em PT-BR                 |
| `mistral-nemo`    | ~7 GB   | Bom em instrução, contexto longo                  |

Para usar outro, ajuste `ollama_model` no `config.yaml` ou exporte
`MEETING_OLLAMA_MODEL`.

---

## 3. Ativar o provedor local

No `.env`:

```dotenv
MEETING_LLM_PROVIDER=local
```

Ou apenas para uma execução, no PowerShell:

```powershell
$env:MEETING_LLM_PROVIDER = "local"
python -m meeting_processor process "C:\Videos\OBS\reuniao.mkv"
```

Para voltar para Claude API:

```dotenv
MEETING_LLM_PROVIDER=anthropic
```

---

## 4. Como saber qual provedor está ativo

- O log no terminal imprime no início:
  `LLM provider: ollama (modelo=qwen2.5:14b, base_url=http://localhost:11434)`
- O provedor efetivo e todos os parâmetros saem do `config.yaml` +
  variáveis de ambiente (ver `meeting_processor/config.py`).

---

## 5. Configurações avançadas

No `config.yaml`:

```yaml
ollama_base_url: "http://localhost:11434"
ollama_model: "qwen2.5:14b"
ollama_temperature: 0.2          # Determinístico para JSON estruturado
ollama_num_ctx: 16384            # Janela de contexto (qwen2.5 vai até 32k)
ollama_request_timeout: 600.0    # 10 min — reuniões longas demoram
```

### Reuniões muito longas

Se uma reunião for maior do que cabe em `num_ctx`, o resumo pode ficar
incompleto. Soluções:

1. Aumente `ollama_num_ctx` (até 32768 com qwen2.5; precisa de RAM/VRAM
   proporcional).
2. Reduza `summary_chunk_minutes` para que cada janela seja mais
   compacta (mas isso aumenta o número de janelas no JSON).

### GPU

O Ollama detecta a GPU automaticamente. Para confirmar:

```bash
ollama ps
```

Se aparecer `100% GPU`, está usando GPU. Se aparecer `100% CPU`, falta
driver/setup — consulte <https://github.com/ollama/ollama/blob/main/docs/gpu.md>.

---

## 6. Solução de problemas

| Erro                                                | Causa                                | Resolução                              |
|-----------------------------------------------------|--------------------------------------|----------------------------------------|
| `Não foi possível conectar ao Ollama`               | Serviço não está rodando             | Abra o app do Ollama ou `ollama serve` |
| `Ollama respondeu 404. ... ollama pull qwen2.5:14b` | Modelo não baixado                   | `ollama pull qwen2.5:14b`              |
| Resumo vazio / JSON inválido                        | Modelo muito pequeno ou contexto cheio | Use 14b+, aumente `ollama_num_ctx`     |
| Muito lento                                         | Rodando em CPU                       | Configure GPU; ou use `qwen2.5:7b`     |
