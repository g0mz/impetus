import type { ReportBrief } from './build.ts';

const n0 = (n: number) => Math.round(n).toLocaleString('pt-BR');
const dec = (n: number, d = 1) => n.toFixed(d).replace('.', ',');
const hm = (min: number) => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
const signed = (n: number, d = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${dec(Math.abs(n), d)}`;

/**
 * Relatório sem LLM (REPORTS.md §6): mesmo template, números literais do brief, 3 insights de maior
 * score (título + ação). Seções sem dados são omitidas. Usado quando o cérebro falha ou está desligado.
 */
export function renderReportFallback(b: ReportBrief): string {
  if (b.kind === 'daily') return renderDaily(b);
  const lines: string[] = [];
  const title = b.kind === 'monthly' ? `📊 Mês ${b.period.label}` : `📊 Semana ${b.period.label}`;
  lines.push(title, '');

  const t = b.training;
  if (t.sessions > 0) {
    const meta =
      b.goals.training_days !== undefined && b.kind === 'weekly' ? ` (meta ${b.goals.training_days})` : '';
    const prs = t.prs.length
      ? ` · ${t.prs.length} PR${t.prs.length > 1 ? 's' : ''} (${t.prs
          .slice(0, 2)
          .map((p) => `${p.exercise} ${p.best.replace('.', ',')}`)
          .join(', ')})`
      : '';
    lines.push(`🏋️ Treino: ${t.sessions} sessões${meta} · ${t.work_sets} séries${prs}`);
    if (b.kind === 'monthly') {
      for (const l of t.top_lifts.slice(0, 5)) {
        lines.push(
          `   • ${l.exercise}: ${dec(l.e1rm_start)} → ${dec(l.e1rm_end)} kg (${signed(l.delta_pct)}%)`,
        );
      }
    }
  }
  const nu = b.nutrition;
  if (nu.complete_days > 0 && nu.kcal_avg !== null) {
    const parts = [`${nu.complete_days}/${nu.days_in_period} dias completos`, `${n0(nu.kcal_avg)} kcal/dia`];
    if (nu.protein_avg !== null) {
      parts.push(
        `proteína ${n0(nu.protein_avg)} g/dia${nu.protein_g_per_kg !== null ? ` (${dec(nu.protein_g_per_kg)} g/kg)` : ''}`,
      );
    }
    if (nu.protein_days_hit !== null) parts.push(`meta em ${nu.protein_days_hit}/${nu.complete_days}`);
    lines.push(`🍽️ Nutrição: ${parts.join(' · ')}`);
  }
  const bo = b.body;
  if (bo.weight_trend_end !== null) {
    const from = bo.weight_trend_start !== null ? `${dec(bo.weight_trend_start)} → ` : '';
    const rate =
      bo.rate_kg_wk !== null
        ? ` (${signed(bo.rate_kg_wk, 2)} kg/sem, ${signed(bo.rate_pct_bw_wk ?? 0, 2)}%)`
        : '';
    lines.push(`⚖️ Peso (tendência): ${from}${dec(bo.weight_trend_end)} kg${rate}`);
    if (b.kind === 'monthly' && bo.maintenance_estimate !== null)
      lines.push(`   Manutenção estimada: ~${n0(bo.maintenance_estimate)} kcal`);
  }
  const act: string[] = [];
  if (b.activity.steps_avg !== null) {
    act.push(
      `🚶 Passos: ${n0(b.activity.steps_avg)}/dia${b.activity.steps_days_hit !== null ? ` (meta em ${b.activity.steps_days_hit}/${b.activity.days_with_data})` : ''}`,
    );
  }
  if (b.sleep.avg_min !== null) {
    act.push(
      `🛌 Sono: ${hm(b.sleep.avg_min)}${b.sleep.regularity_min !== null ? ` (regularidade ±${b.sleep.regularity_min} min)` : ''}`,
    );
  }
  if (act.length) lines.push(act.join(' · '));

  const special = b.insights.filter((i) => i.severity === 'celebration' || i.domain === 'system');
  const top = b.insights.filter((i) => !special.includes(i)).slice(0, 3);
  if (top.length || special.length) {
    lines.push('', '💡 Destaques');
    top.forEach((i, k) => lines.push(`${k + 1}. ${i.title}.${i.action ? ` ${i.action}` : ''}`));
    for (const s of special.filter((x) => x.domain === 'system'))
      lines.push(`⚠️ ${s.title}. ${s.action ?? ''}`.trim());
  }
  const focus = top[0]?.action;
  if (focus) lines.push('', `➡️ Foco da ${b.kind === 'monthly' ? 'mês' : 'semana'}: ${focus}`);
  if (lines.length <= 2)
    lines.push('Sem registros suficientes no período. Registre treinos e refeições para ver o resumo.');
  const text = lines.join('\n').replace('Foco da mês', 'Foco do mês');
  return text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
}

function renderDaily(b: ReportBrief): string {
  const d = b.today!;
  const prot =
    b.goals.protein_g !== undefined
      ? `${n0(d.protein_g)}/${n0(b.goals.protein_g)}g proteína${d.remaining_protein_g ? ` (faltam ${n0(d.remaining_protein_g)}g)` : ''}`
      : `${n0(d.protein_g)}g proteína`;
  const parts = [`${n0(d.kcal)} kcal`, prot, d.trained ? `treino: ${d.trained}` : 'sem treino'];
  if (d.steps !== null) parts.push(`${n0(d.steps)} passos`);
  return `📅 Hoje: ${parts.join(' · ')}`;
}
