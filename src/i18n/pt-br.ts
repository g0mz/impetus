/** Textos ao usuário (PT-BR), centralizados. */
export const t = {
  help: [
    '🤖 *Impetus* — comandos:',
    '• /treino <rotina> — última sessão e alvos de hoje',
    '• /ultimo <exercício> — últimas 3 sessões do exercício',
    '• /metas — metas atuais · /meta <chave> <valor> — define (ou "remover")',
    '  chaves: kcal, proteina, passos, sono, treinos, ritmo_peso, peso_alvo',
    '• /desfazer — desfaz o último registro',
    '• /ajuda — esta lista',
    '',
    'Ou escreva livremente, por exemplo:',
    '• "meu upper B é: supino inclinado halter 3x8-12, remada curvada 4x6-10"',
    '• "upper B: supino inclinado halter 3x10 30kg, remada curvada 4x8 60kg"',
    '• "supino 32kg 10 9 8" (anexa ao treino em andamento)',
    '• "30 min esteira"',
  ].join('\n'),
  unknownCommand: (name: string) => `Comando /${name} não reconhecido. Veja /ajuda.`,
  notYet: (name: string) => `/${name} ainda não está disponível nesta versão.`,
  usage: (u: string) => `Uso: ${u}`,
  routineNotFound: (name: string, known: string[]) =>
    `Não encontrei a rotina "${name}".${known.length ? ` Rotinas: ${known.join(', ')}.` : ' Nenhuma rotina definida ainda.'}`,
  exerciseNotFound: (q: string) => `Não encontrei exercício para "${q}".`,
  noHistory: (name: string) => `Sem registros de ${name} ainda.`,
  goalsEmpty: 'Nenhuma meta definida. Ex.: /meta proteina 150',
  goalSet: (label: string, value: string) => `🎯 Meta de ${label}: ${value}`,
  goalRemoved: (label: string) => `🎯 Meta de ${label} removida.`,
  goalUnknownKey: (key: string) =>
    `Meta "${key}" desconhecida. Use: kcal, proteina, passos, sono, treinos, ritmo_peso, peso_alvo.`,
  undoNothing: 'Nada para desfazer.',
  undoDone: (what: string) => `↩️ Desfeito: ${what}.`,
  brainFailed: 'Não consegui processar agora, tento de novo em 10 min.',
  brainDeferred: 'Atingi o limite de uso do momento; processo sua mensagem na próxima hora cheia.',
  brainUnavailable: 'O assistente está desligado (só comandos /). Veja /ajuda.',
} as const;

export const GOAL_LABELS: Record<string, { label: string; unit: string }> = {
  kcal: { label: 'calorias', unit: 'kcal' },
  protein_g: { label: 'proteína', unit: 'g' },
  steps: { label: 'passos', unit: 'passos' },
  sleep_h: { label: 'sono', unit: 'h' },
  training_days: { label: 'treinos por semana', unit: 'dias' },
  weight_rate_kg_wk: { label: 'ritmo de peso', unit: 'kg/semana' },
  weight_target_kg: { label: 'peso alvo', unit: 'kg' },
};
