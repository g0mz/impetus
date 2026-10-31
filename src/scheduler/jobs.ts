import path from 'node:path';
import { Cron } from 'croner';
import type { Db } from '../db/index.ts';
import { getSetting, setSetting } from '../db/repos/settings.ts';
import { t } from '../i18n/pt-br.ts';
import { hcStaleAlert } from '../ingest/process.ts';
import type { Logger } from '../logger.ts';
import { reportPeriod, type ReportKind } from '../reports/build.ts';
import { runBackup } from '../ops/backup.ts';
import { pruneNotes } from '../db/repos/coach-notes.ts';
import { toLocalDate, nowUtcIso, weekdayPt } from '../time.ts';
import { syncDiary } from '../vault/diary.ts';

export type Notify = (text: string, opts?: { critical?: boolean }) => Promise<void>;

export type JobDef = {
  name: string;
  cron: string;
  /** Chave do período (idempotência após reinício). Sem ela, roda a cada disparo. */
  periodKey?: (now: string) => string;
  run: (now: string) => Promise<string | void>;
};

export type SchedulerDeps = {
  db: Db;
  logger: Logger;
  timeZone: string;
  cutoffHour: number;
  clock?: () => string;
};

/** Executa um job com registro em job_runs; com periodKey, não repete um período já concluído. */
export async function runJob(
  deps: SchedulerDeps,
  job: JobDef,
  now = (deps.clock ?? nowUtcIso)(),
): Promise<'ran' | 'skipped' | 'failed'> {
  const key = job.periodKey ? `${job.name}:${job.periodKey(now)}` : job.name;
  if (job.periodKey) {
    const done = deps.db.prepare('SELECT 1 FROM job_runs WHERE job = ? AND ok = 1 LIMIT 1').get(key);
    if (done) return 'skipped';
  }
  const id = Number(
    deps.db.prepare('INSERT INTO job_runs (job, started_at) VALUES (?, ?)').run(key, now).lastInsertRowid,
  );
  try {
    const detail = await job.run(now);
    deps.db
      .prepare('UPDATE job_runs SET finished_at = ?, ok = 1, detail = ? WHERE id = ?')
      .run(nowUtcIso(), detail ?? null, id);
    return 'ran';
  } catch (e) {
    deps.db
      .prepare('UPDATE job_runs SET finished_at = ?, ok = 0, detail = ? WHERE id = ?')
      .run(nowUtcIso(), String(e).slice(0, 500), id);
    deps.logger.error({ err: e, job: key }, 'job falhou');
    return 'failed';
  }
}

/** Liga os jobs no croner (fuso do usuário). `protect` evita sobreposição do mesmo job. */
export function startScheduler(deps: SchedulerDeps, jobs: JobDef[]) {
  const crons = jobs.map(
    (j) =>
      new Cron(j.cron, { timezone: deps.timeZone, protect: true, name: j.name }, () => void runJob(deps, j)),
  );
  deps.logger.info({ jobs: jobs.map((j) => `${j.name} (${j.cron})`) }, 'scheduler iniciado');
  return { stop: () => crons.forEach((c) => c.stop()) };
}

export type JobsInput = SchedulerDeps & {
  notify: Notify;
  report: (kind: ReportKind) => Promise<{ text: string; reportId: number; charts?: string[] }>;
  /** Envia os gráficos depois do texto (opcional por canal). */
  notifyImages?: (paths: string[]) => Promise<void>;
  retryTurn: (turnId: number) => Promise<boolean>;
  /** Gera e envia o check-in da manhã; devolve o resumo para job_runs (Fase 8d). */
  checkin?: () => Promise<string>;
  /** Organização noturna do cofre (Fase 9b); devolve o resumo para job_runs. */
  organize?: (now: string) => Promise<string>;
  /** Espera o canal ficar pronto para enviar; false = desistiu (não gera o relatório, não gasta cota). */
  waitChannel?: () => Promise<boolean>;
  config: {
    REPORT_DAILY: boolean;
    REPORT_DAILY_TIME: string;
    REPORT_WEEKLY_CRON: string;
    REPORT_MONTHLY_CRON: string;
    CHECKIN_ENABLED?: boolean;
    CHECKIN_CRON?: string;
    HC_STALE_HOURS: number;
    CLAUDE_TOKEN_EXPIRES_AT?: string | undefined;
    DATA_DIR: string;
    BACKUP_REMOTE?: string | undefined;
    BACKUP_KEEP_DAYS?: number;
    VAULT_DIR?: string | undefined;
    VAULT_ORGANIZE_CRON?: string;
  };
};

/** Jobs de REPORTS.md §1 (relatórios, alertas, reprocessamento, backup). */
export function buildJobs(i: JobsInput): JobDef[] {
  const local = (now: string) => toLocalDate(now, i.cutoffHour, i.timeZone);
  const sendReport = (kind: ReportKind) => async () => {
    if (getSetting<boolean>(i.db, 'proactive.paused')) return 'pulado (pausado)';
    if (i.waitChannel && !(await i.waitChannel()))
      throw new Error('canal indisponível; relatório não gerado');
    const r = await i.report(kind);
    await i.notify(r.text);
    if (r.charts?.length && i.notifyImages) await i.notifyImages(r.charts);
    i.db.prepare('UPDATE reports SET sent_at = ? WHERE id = ?').run(nowUtcIso(), r.reportId);
    return `report ${r.reportId}`;
  };
  const [dh, dm] = i.config.REPORT_DAILY_TIME.split(':');

  const retry = (status: 'failed' | 'deferred', minAgeMin: number) => async (now: string) => {
    const since = new Date(Date.parse(now) - 24 * 3600_000).toISOString();
    const until = new Date(Date.parse(now) - minAgeMin * 60_000).toISOString();
    const turns = i.db
      .prepare(
        `SELECT t.id FROM turns t WHERE t.status = ? AND t.kind = 'chat' AND t.finished_at BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM job_runs j WHERE j.job = 'turn.retry:' || t.id)`,
      )
      .pluck()
      .all(status, since, until) as number[];
    for (const id of turns) {
      i.db
        .prepare('INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, 1)')
        .run(`turn.retry:${id}`, now, now);
      await i.retryTurn(id);
    }
    return `${turns.length} turno(s)`;
  };

  const jobs: JobDef[] = [
    {
      name: 'report.weekly',
      cron: i.config.REPORT_WEEKLY_CRON,
      periodKey: (now) => reportPeriod('weekly', local(now)).start,
      run: sendReport('weekly'),
    },
    {
      name: 'report.monthly',
      cron: i.config.REPORT_MONTHLY_CRON,
      periodKey: (now) => reportPeriod('monthly', local(now)).start,
      run: sendReport('monthly'),
    },
    {
      name: 'report.daily',
      cron: `${Number(dm)} ${Number(dh)} * * *`,
      periodKey: local,
      run: async (now) => {
        const enabled = getSetting<boolean>(i.db, 'report.daily') ?? i.config.REPORT_DAILY;
        const d = local(now);
        const any = i.db
          .prepare(
            `SELECT (SELECT count(*) FROM meals WHERE local_date = ? AND deleted_at IS NULL) +
                    (SELECT count(*) FROM workout_sessions WHERE local_date = ? AND deleted_at IS NULL)`,
          )
          .pluck()
          .get(d, d) as number;
        if (!enabled || !any) return 'pulado (desligado ou sem registros)';
        return sendReport('daily')();
      },
    },
    {
      name: 'alert.hc_stale',
      cron: '0 */6 * * *',
      run: async (now) => {
        const msg = hcStaleAlert(i.db, now, i.config.HC_STALE_HOURS);
        if (msg) await i.notify(msg);
        return msg ? 'alertado' : 'ok';
      },
    },
    {
      name: 'alert.claude_token',
      cron: '0 10 * * *',
      periodKey: local,
      run: async (now) => {
        const exp = i.config.CLAUDE_TOKEN_EXPIRES_AT;
        if (!exp) return 'sem data de expiração';
        const daysLeft = Math.round(
          (Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${local(now)}T00:00:00Z`)) / 86400_000,
        );
        if ([30, 7, 1].includes(daysLeft) || daysLeft <= 0) {
          await i.notify(
            daysLeft <= 0
              ? '🔑 O token do Claude expirou. No PC: `claude setup-token`, atualize /etc/impetus/env e reinicie o serviço.'
              : `🔑 O token do Claude expira em ${daysLeft} dia(s) (${exp}). Renove com \`claude setup-token\` (DEPLOY.md §8).`,
            { critical: true },
          );
          return `avisado (${daysLeft} dias)`;
        }
        return `${daysLeft} dias restantes`;
      },
    },
    {
      // cérebro falhando em sequência (token, cota, CLI quebrada): avisa no máximo a cada 6 h
      name: 'alert.turns_failing',
      cron: '5 * * * *',
      run: async (now) => {
        const since = new Date(Date.parse(now) - 2 * 3600_000).toISOString();
        const failed = i.db
          .prepare("SELECT count(*) FROM turns WHERE status = 'failed' AND finished_at >= ?")
          .pluck()
          .get(since) as number;
        const last = getSetting<string>(i.db, 'alert.turns_failing.last');
        if (failed < 3 || (last && Date.parse(now) - Date.parse(last) < 6 * 3600_000))
          return `${failed} falha(s) em 2 h`;
        setSetting(i.db, 'alert.turns_failing.last', now);
        await i.notify(t.turnsFailing(failed), { critical: true });
        return `avisado (${failed})`;
      },
    },
    {
      // chip pré-pago do bot vence em 30 dias sem recarga: avisa a partir do dia 25 (crítico, ignora /pausar)
      name: 'alert.sim_recharge',
      cron: '0 11 * * *',
      periodKey: local,
      run: async (now) => {
        const last = getSetting<string>(i.db, 'sim.last_recharge');
        if (!last) return 'sem recarga anotada';
        const days = Math.round(
          (Date.parse(`${local(now)}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400_000,
        );
        if (days < 25) return `${days} dias`;
        await i.notify(t.rechargeDue(days), { critical: true });
        return `avisado (${days} dias)`;
      },
    },
    {
      // relatório semanal/mensal que falhou (canal fora, cérebro e fallback com erro): tenta de novo a cada hora
      name: 'report.catchup',
      cron: '15 * * * *',
      run: async (now) => {
        const done: string[] = [];
        for (const kind of ['weekly', 'monthly'] as const) {
          const key = `report.${kind}:${reportPeriod(kind, local(now)).start}`;
          const failed = i.db.prepare('SELECT 1 FROM job_runs WHERE job = ? AND ok = 0 LIMIT 1').get(key);
          const ok = i.db.prepare('SELECT 1 FROM job_runs WHERE job = ? AND ok = 1 LIMIT 1').get(key);
          if (!failed || ok) continue;
          const job = jobs.find((j) => j.name === `report.${kind}`)!;
          done.push(`${kind}: ${await runJob(i, job, now)}`);
        }
        return done.join(', ') || 'nada a recuperar';
      },
    },
    {
      // check-in da manhã: o código decide se há algo a dizer; dia sem novidade não manda nada (Fase 8d)
      name: 'checkin',
      cron: i.config.CHECKIN_CRON ?? '30 7 * * *',
      periodKey: local,
      run: async () => {
        if (!i.checkin || i.config.CHECKIN_ENABLED === false) return 'desligado';
        if (getSetting<boolean>(i.db, 'proactive.paused')) return 'pulado (pausado)';
        if (i.waitChannel && !(await i.waitChannel()))
          throw new Error('canal indisponível; check-in não gerado');
        return i.checkin();
      },
    },
    {
      // memória do coach: eventos resolvidos há 30+ dias e observações paradas há 90+ dias (Fase 8b)
      name: 'coach_notes.prune',
      cron: '30 3 * * 1',
      periodKey: local,
      run: async (now) => `${pruneNotes(i.db, now)} nota(s) arquivada(s)`,
    },
    { name: 'turns.retry_failed', cron: '*/10 * * * *', run: retry('failed', 10) },
    { name: 'turns.retry_deferred', cron: '0 * * * *', run: retry('deferred', 1) },
    {
      name: 'backup',
      cron: '30 3 * * *',
      periodKey: local,
      run: async (now) => {
        const d = local(now);
        try {
          const r = await runBackup({
            db: i.db,
            backupsDir: path.join(i.config.DATA_DIR, 'backups'),
            localDate: d,
            keepDays: i.config.BACKUP_KEEP_DAYS ?? 14,
            remote: i.config.BACKUP_REMOTE,
            mediaDir: path.join(i.config.DATA_DIR, 'media'),
            syncMedia: weekdayPt(d) === 'domingo',
          });
          return `${path.basename(r.file)} ${Math.round(r.bytes / 1024)} KB · podados ${r.pruned}${r.uploaded ? ' · enviado' : ' · só local'}`;
        } catch (e) {
          await i.notify(`🚨 Backup falhou: ${String((e as Error).message).slice(0, 200)}`, {
            critical: true,
          });
          throw e;
        }
      },
    },
  ];

  if (i.config.VAULT_DIR) {
    const vaultDir = i.config.VAULT_DIR;
    jobs.push({
      // diário bruto do cofre (Fase 9a): derivado de `messages`, sem IA; só reescreve se chegou mensagem nova
      name: 'vault.diary',
      cron: '*/5 * * * *',
      run: async (now) => syncDiary(i.db, vaultDir, now, { cutoffHour: i.cutoffHour, timeZone: i.timeZone }),
    });
    if (i.organize) {
      const organize = i.organize;
      jobs.push({
        // uma chamada ao coach por noite (Fase 9b); noite que falha é recuperada na seguinte
        name: 'vault.organize',
        cron: i.config.VAULT_ORGANIZE_CRON ?? '30 4 * * *',
        periodKey: local,
        run: (now) => organize(now),
      });
    }
  }
  return jobs;
}
