/** Textos ao usuário (PT-BR), centralizados. */
export const t = {
  help: [
    '🤖 *Impetus* — comandos:',
    '• /treino [rotina] — cargas salvas, última sessão e alvos (sem rotina: a planejada para hoje)',
    '• /ultimo <exercício> — últimas 3 sessões do exercício',
    '• /metas — metas atuais · /meta <chave> <valor> — define (ou "remover")',
    '  chaves: kcal, proteina, passos, sono, treinos, ritmo_peso, peso_alvo',
    '• /desfazer — desfaz o último registro',
    '• /status — saúde do sistema',
    '• /hoje — resumo do dia · /peso <kg> — registra peso',
    '• /relatorio [dia|semana|mes] — relatório na hora',
    '• /notas — o que eu lembro sobre você · /esquecer <id> — apaga uma nota',
    '• /pausar · /retomar — mensagens automáticas',
    '• /recarga — anota a recarga do chip do bot (lembrete mensal)',
    '• /ajuda — esta lista',
    '',
    'Ou escreva livremente, por exemplo:',
    '• "meu upper B é: supino inclinado halter 3x10 30kg, remada curvada 4x8 60kg"',
    '• "fiz upper B" (usa as cargas salvas) · "fiz upper B, supino subi pra 32"',
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
  restDay: '😴 Hoje é dia de descanso no seu plano. Para ver uma rotina: /treino <rotina>',
  notesEmpty: '🧠 Ainda não guardei nada sobre você além dos seus registros.',
  notesHint: 'Para eu esquecer algo: /esquecer <id>. Ou só me diga.',
  noteForgotten: (id: number) => `🗑️ Nota ${id} esquecida.`,
  undoDone: (what: string) => `↩️ Desfeito: ${what}.`,
  brainFailed: 'Não consegui processar agora, tento de novo em 10 min.',
  brainDeferred: 'Atingi o limite de uso do momento; processo sua mensagem na próxima hora cheia.',
  brainUnavailable: 'O assistente está desligado (só comandos /). Veja /ajuda.',
  paused:
    '⏸️ Mensagens automáticas pausadas (relatórios e lembretes). Alertas críticos continuam. /retomar para voltar.',
  resumed: '▶️ Mensagens automáticas retomadas.',
  rechargeSaved: (d: string) => `📶 Recarga do chip anotada (${d}). Te lembro antes de vencer.`,
  rechargeDue: (days: number) =>
    `📶 Faz ${days} dias da última recarga do chip do bot. Recarregue (mín. R$ 15) para a linha não ser cancelada e mande /recarga.`,
  turnsFailing: (n: number) =>
    `🚨 ${n} mensagens falharam no cérebro nas últimas 2 h. Veja /status e \`journalctl -u impetus\` (token, cota ou CLI).`,
  audioUnavailable:
    '🎤 Ainda não consigo ouvir áudio por aqui (transcrição desligada). Mande por texto, por favor.',
  audioTooLong: (max: number) =>
    `🎤 Áudio longo demais (máx. ${Math.round(max / 60)} min). Mande em partes ou por texto.`,
  audioFailed: '🎤 Não consegui entender o áudio. Pode repetir ou mandar por texto?',
  unconfirmedWrite:
    '⚠️ Atenção: nada foi gravado nesta mensagem. Confira com /hoje ou /ultimo e me mande de novo o que faltou.',
  skippedReports: (cmds: string) => `Durante a pausa pulei relatório(s); para ver agora: ${cmds}`,
  reportGenerating: '📊 Gerando o relatório…',
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

/** Dashboard somente leitura (DASHBOARD=true), lido no celular pela tailnet. */
export const dash = {
  app: 'Impetus',
  nav: {
    peso: 'peso',
    nutricao: 'nutrição',
    treino: 'treino',
    exercicio: 'exercício',
    sono: 'sono',
  },
  titulo: {
    resumo: 'Resumo',
    peso: 'Peso',
    nutricao: 'Nutrição',
    treino: 'Treino',
    exercicio: 'Exercício',
    sono: 'Sono e atividade',
  },
  periodo: { '7d': '7 dias', '30d': '30 dias', '90d': '90 dias', ano: '1 ano' },
  semDadosSaude:
    'Nada do relógio ainda. Ligue os tipos no app HC Webhook (passos, sono, frequência cardíaca) e os dados aparecem aqui no próximo sync.',
  semSono: 'Sono não está sendo enviado pelo relógio. Habilite "Sleep" no app HC Webhook.',
  semPeso: 'Nenhuma pesagem no período. Mande o peso no WhatsApp para a tendência começar.',
  semRefeicoes: 'Nenhuma refeição registrada no período.',
  semTreino: 'Nenhum treino registrado no período.',
  poucosDados: (faltam: number) => `Poucos dados: mais ${faltam} dia(s) e a tendência ganha sentido.`,
  escolhaExercicio: 'Escolha um exercício',
  verTodos: 'ver',
  metaLabel: 'meta',
  mediaLabel: 'média',
} as const;
