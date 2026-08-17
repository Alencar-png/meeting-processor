"""Integração com a estrutura wiki do claude-obsidian."""

import logging

from .config import Settings

logger = logging.getLogger(__name__)


class WikiIntegrator:
    """Atualiza index.md, log.md e hot.md do vault claude-obsidian."""

    def __init__(self, config: Settings):
        self.config = config

    def register_meeting(
        self,
        title: str,
        date_str: str,
        source_file: str,
        duration: str,
        task_count: int,
        key_topics: list[str],
    ) -> None:
        """Registra a reunião no index, log e hot cache do vault.

        Args:
            title: Título da nota de reunião.
            date_str: Data no formato YYYY-MM-DD.
            source_file: Nome do arquivo de vídeo original.
            duration: Duração formatada (HH:MM:SS).
            task_count: Quantidade de tarefas extraídas.
            key_topics: Tópicos principais da reunião.
        """
        self._update_index(title)
        self._update_log(title, date_str, source_file, duration, task_count)
        self._update_hot_cache(title, key_topics, task_count)

    def _update_index(self, title: str) -> None:
        """Adiciona a reunião ao index.md do wiki."""
        index_path = self.config.vault_path / "wiki" / "index.md"
        if not index_path.exists():
            logger.warning("index.md não encontrado em %s", index_path)
            return

        content = index_path.read_text(encoding="utf-8")
        meeting_entry = f"- [[{title}]]"

        # Verifica se já existe
        if meeting_entry in content:
            return

        # Procura seção Meetings ou cria
        meetings_header = "### Meetings"
        if meetings_header in content:
            # Adiciona após o header existente
            idx = content.index(meetings_header) + len(meetings_header)
            content = content[:idx] + f"\n{meeting_entry}" + content[idx:]
        else:
            # Adiciona seção no final
            content = content.rstrip() + f"\n\n{meetings_header}\n{meeting_entry}\n"

        index_path.write_text(content, encoding="utf-8")
        logger.info("index.md atualizado com: %s", title)

    def _update_log(
        self,
        title: str,
        date_str: str,
        source_file: str,
        duration: str,
        task_count: int,
    ) -> None:
        """Adiciona entrada no log.md do wiki."""
        log_path = self.config.vault_path / "wiki" / "log.md"

        entry = (
            f"\n## [{date_str}] ingest | {title}\n"
            f"- **type**: meeting-transcription\n"
            f"- **source**: {source_file}\n"
            f"- **duration**: {duration}\n"
            f"- **pages created**: {title}\n"
            f"- **tasks extracted**: {task_count}\n"
            f"- **location**: wiki/meetings/\n"
        )

        if log_path.exists():
            content = log_path.read_text(encoding="utf-8")
            content = content.rstrip() + "\n" + entry
        else:
            content = f"# Wiki Operations Log\n{entry}"

        log_path.write_text(content, encoding="utf-8")
        logger.info("log.md atualizado.")

    def _update_hot_cache(
        self,
        title: str,
        key_topics: list[str],
        task_count: int,
    ) -> None:
        """Atualiza hot.md com informações da última reunião processada."""
        hot_path = self.config.vault_path / "wiki" / "hot.md"

        topics_str = ", ".join(key_topics) if key_topics else "N/A"
        meeting_line = (
            f"- **Ultima reuniao**: [[{title}]] "
            f"- Topicos: {topics_str} "
            f"- {task_count} tarefa(s) extraida(s)\n"
        )

        if hot_path.exists():
            content = hot_path.read_text(encoding="utf-8")
            content = content.rstrip() + "\n" + meeting_line
        else:
            content = f"# Hot Cache\n\n{meeting_line}"

        hot_path.write_text(content, encoding="utf-8")
        logger.info("hot.md atualizado com informacoes da reuniao.")
