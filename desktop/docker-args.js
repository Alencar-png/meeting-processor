'use strict';

/**
 * Montagem do comando do container — funções puras, sem efeito colateral,
 * para o comando executado pelo app ser conferível fora dele.
 */

const path = require('node:path');

const IMAGE_NAME = 'meeting-processor:latest';
const MODELS_VOLUME = 'meeting-processor-models';

/**
 * Argumentos do `docker run` que transcreve um arquivo.
 *
 * A pasta do vídeo entra somente-leitura em /input e a de saída em /output;
 * o volume de modelos persiste o download do Whisper entre execuções.
 */
function buildDockerArgs({
  videoPath, outputDir, model, language, formats, containerName, name = '',
}) {
  return [
    'run', '--rm', '--name', containerName,
    '-v', `${path.dirname(videoPath)}:/input:ro`,
    '-v', `${outputDir}:/output`,
    '-v', `${MODELS_VOLUME}:/models`,
    '-e', `WHISPER_MODEL=${model}`,
    '-e', `MEETING_WHISPER_LANGUAGE=${language}`,
    IMAGE_NAME,
    'transcribe', `/input/${path.basename(videoPath)}`,
    '--output-dir', '/output',
    '--formats', formats.join(','),
    ...(name ? ['--name', name] : []),
    '--json',
  ];
}

/**
 * Converte um caminho de dentro do container de volta para o caminho do host.
 *
 * Preserva o que vem depois de `/output`: a transcrição fica numa subpasta com
 * o nome da reunião, e só o nome do arquivo não bastaria para achá-la.
 */
function toHostPath(containerPath, outputDir) {
  const relative = containerPath.replace(/^\/?output\/?/, '');
  return path.join(outputDir, ...relative.split('/').filter(Boolean));
}

module.exports = { IMAGE_NAME, MODELS_VOLUME, buildDockerArgs, toHostPath };
