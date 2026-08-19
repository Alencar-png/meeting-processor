Leia a transcrição em `{{TRANSCRICAO}}` (gerada por reconhecimento de fala — pode
conter erros de grafia e falas cortadas) e extraia as **ações combinadas** na
reunião.

## Contexto do projeto

{{CONTEXTO}}

## O que conta como tarefa

Uma tarefa é algo que alguém precisa **fazer** depois da reunião: um
compromisso assumido, um pedido aceito, um próximo passo definido.

- Não invente responsáveis, prazos ou tarefas que ninguém mencionou — nem a
  partir do contexto do projeto.
- Agrupe falas repetidas sobre o mesmo assunto numa tarefa só.
- Ignore conversa paralela, a menos que carregue um compromisso.
- Se a reunião não gerou nenhuma ação, devolva a lista vazia. Uma lista vazia
  honesta vale mais que tarefas inventadas.

## Saída

Escreva **apenas** um arquivo JSON em `{{JSON}}`, com esta forma exata:

```json
{
  "title": "assunto da reunião em 3 a 6 palavras",
  "tasks": [
    {
      "title": "frase curta no infinitivo, até 60 caracteres",
      "description": "uma ou duas frases com o que ficou combinado",
      "assignee": "nome citado na reunião, ou string vazia",
      "priority": "high | medium | low"
    }
  ]
}
```

Regras da saída:

- `title` nomeia a reunião pelo assunto tratado, como alguém a chamaria na
  conversa: "Alinhamento do módulo de usuários", "Consulta de retorno". Sem
  data, sem hora, sem a palavra "reunião" no começo, sem ponto final e sem os
  caracteres `< > : " / \ | ? *`.
- `priority` é `high` quando há urgência ou dependência explícita, `low` quando
  foi tratado como opcional, `medium` no resto.
- `assignee` só recebe nome dito na transcrição. Sem nome, use `""`.
- Nada de comentários, markdown ou texto fora do JSON.

Ao final, responda em uma única linha: o título escolhido e quantas tarefas o
arquivo contém.
