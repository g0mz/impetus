import type { Db } from '../db/index.ts';

/**
 * Memo de HTML por rota+período. `buildReportBrief` carrega 120 dias de séries e o histórico de
 * peso a cada chamada, e renderizar Vega custa CPU numa VM de 1 GB.
 *
 * A marca de validade junta `audit_log` (escritas por tool ou comando) e `health_daily`
 * (dados do relógio): `ingest/process.ts` grava os segundos **sem** passar pelo `audit_log`, então
 * só a primeira fonte deixaria passos e sono velhos na tela até a próxima refeição registrada.
 */
export function createPageCache(db: Db) {
  const entries = new Map<string, { stamp: string; html: string }>();
  const stampSt = db.prepare(
    `SELECT (SELECT COALESCE(max(id), 0) FROM audit_log) AS a,
            (SELECT COALESCE(max(updated_at), '') FROM health_daily) AS h`,
  );

  const stamp = (): string => {
    const r = stampSt.get() as { a: number; h: string };
    return `${r.a}|${r.h}`;
  };

  return {
    stamp,
    async get(key: string, build: () => Promise<string>): Promise<string> {
      const now = stamp();
      const hit = entries.get(key);
      if (hit && hit.stamp === now) return hit.html;
      const html = await build();
      entries.set(key, { stamp: now, html });
      return html;
    },
  };
}
