export type BrainMode = 'turn' | 'report';
export type ToolScopeName = 'all' | 'read';

export type BrainInput = {
  prompt: string;
  /** Caminhos absolutos de imagens já referenciadas no prompt (o modelo usa Read). */
  images: string[];
  mode: BrainMode;
  toolScope: ToolScopeName;
  turnToken: string;
  model: string;
};

export type BrainErrorKind = 'timeout' | 'usage_limit' | 'auth' | 'max_turns' | 'unavailable' | 'error';

export type BrainResult = {
  ok: boolean;
  /** Texto final para o usuário (vazio quando !ok). */
  text: string;
  errorKind?: BrainErrorKind;
  errorMessage?: string;
  usage?: unknown;
  costUsd?: number;
  numTurns?: number;
  durationMs: number;
};

/** Cérebro plugável: nada fora de brain/ sabe que existe uma CLI `claude`. */
export interface Brain {
  readonly name: string;
  run(input: BrainInput): Promise<BrainResult>;
}

/** BRAIN_PROVIDER=none: só comandos e fallbacks determinísticos. */
export const noneBrain: Brain = {
  name: 'none',
  run: async () => ({
    ok: false,
    text: '',
    errorKind: 'unavailable',
    errorMessage: 'BRAIN_PROVIDER=none',
    durationMs: 0,
  }),
};
