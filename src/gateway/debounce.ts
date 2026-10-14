/**
 * Debounce de turnos (ARCHITECTURE.md §4.2): mensagens próximas viram um turno só. Janela padrão
 * após a última mensagem; maior quando a última é imagem sem legenda (o texto costuma vir depois).
 */
export function createDebouncer<T extends { imageOnly: boolean }>(opts: {
  ms: number;
  imageMs: number;
  onFlush: (batch: T[]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}) {
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  let batch: T[] = [];
  let timer: unknown;

  const flush = () => {
    timer = undefined;
    const b = batch;
    batch = [];
    if (b.length) opts.onFlush(b);
  };

  return {
    add(item: T) {
      batch.push(item);
      if (timer !== undefined) clearT(timer);
      timer = setT(flush, item.imageOnly ? opts.imageMs : opts.ms);
    },
    flushNow: flush,
    get pending() {
      return batch.length;
    },
  };
}
