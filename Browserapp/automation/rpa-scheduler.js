'use strict';

function parseBoolean(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function parseCronPart(part, min, max, { sunday = false } = {}) {
  const values = new Set();
  const add = (value) => {
    let number = Number(value);
    if (sunday && number === 7) number = 0;
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`计划任务 cron 数值超出范围：${value}`);
    }
    values.add(number);
  };

  for (const token of String(part || '').split(',')) {
    const value = token.trim();
    if (!value) throw new Error('计划任务 cron 含有空字段');
    const [base, stepText] = value.split('/');
    const step = stepText == null ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`计划任务 cron 步长无效：${value}`);
    if (base === '*') {
      for (let current = min; current <= max; current += step) add(current);
      continue;
    }
    const range = base.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      // 7 is an alias for Sunday, so a weekday range may legitimately end at 7
      // (0-7 = every day, 5-7 = Fri–Sun). add() maps each produced value.
      const upper = sunday ? max + 1 : max;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || start > upper || end < min || end > upper || end < start) {
        throw new Error(`计划任务 cron 范围无效：${value}`);
      }
      for (let current = start; current <= end; current += step) add(current);
      continue;
    }
    if (stepText != null) throw new Error(`计划任务 cron 写法无效：${value}`);
    add(base);
  }
  return values;
}

function compileCron(expression) {
  const cron = String(expression || '').trim().replace(/\s+/g, ' ');
  const parts = cron.split(' ');
  if (parts.length !== 5) {
    throw new Error('计划任务 cron 必须是 5 段：分 时 日 月 周，例如 0 9 * * 1-5');
  }
  return {
    expression: cron,
    minute: parseCronPart(parts[0], 0, 59),
    hour: parseCronPart(parts[1], 0, 23),
    day: parseCronPart(parts[2], 1, 31),
    month: parseCronPart(parts[3], 1, 12),
    weekday: parseCronPart(parts[4], 0, 6, { sunday: true }),
    dayAny: parts[2] === '*',
    weekdayAny: parts[4] === '*',
  };
}

function cronMatches(compiledOrExpression, date = new Date()) {
  const cron = typeof compiledOrExpression === 'string'
    ? compileCron(compiledOrExpression)
    : compiledOrExpression;
  const dayMatch = cron.day.has(date.getDate());
  const weekdayMatch = cron.weekday.has(date.getDay());
  // Standard cron behavior: when both day fields are restricted, either one
  // can match; when only one is restricted, that field must match.
  const calendarMatch = cron.dayAny && cron.weekdayAny
    ? true
    : cron.dayAny
      ? weekdayMatch
      : cron.weekdayAny
        ? dayMatch
        : dayMatch || weekdayMatch;
  return cron.minute.has(date.getMinutes())
    && cron.hour.has(date.getHours())
    && cron.month.has(date.getMonth() + 1)
    && calendarMatch;
}

function localMinuteSlot(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeSchedule(input, existing = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const previous = existing && typeof existing === 'object' ? existing : {};
  const enabled = parseBoolean(source.enabled ?? previous.enabled ?? false);
  const cron = String(source.cron ?? previous.cron ?? '0 9 * * *').trim().replace(/\s+/g, ' ');
  if (enabled) compileCron(cron);
  const unchanged = cron === String(previous.cron || '').trim().replace(/\s+/g, ' ');
  return {
    enabled,
    cron,
    timezone: 'local',
    last_run_slot: unchanged ? String(source.last_run_slot ?? previous.last_run_slot ?? '') : '',
    last_run_at: unchanged ? (source.last_run_at ?? previous.last_run_at ?? null) : null,
    last_result: unchanged ? (source.last_result ?? previous.last_result ?? null) : null,
    last_error: unchanged ? String(source.last_error ?? previous.last_error ?? '') : '',
  };
}

class RpaScheduler {
  constructor({ store, engine, emit = () => {}, intervalMs = 15000 } = {}) {
    this.store = store;
    this.engine = engine;
    this.emit = emit;
    this.intervalMs = Math.max(5000, Number(intervalMs) || 15000);
    this.timer = null;
    this.runningPlans = new Set();
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this.tick().catch(() => {});
    return this;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async updatePlanSchedule(planId, patch) {
    const latest = this.store.getPlan(planId);
    if (!latest) return null;
    return this.store.upsertPlan({
      ...latest,
      schedule: { ...(latest.schedule || {}), ...patch },
    });
  }

  async runScheduledPlan(plan, slot) {
    this.runningPlans.add(plan.id);
    try {
      const result = await this.engine.runPlan(plan.id, {
        profile_ids: plan.profile_ids || [],
        task_type: 'plan',
        schedule_id: plan.id,
        trigger: 'schedule',
      });
      await this.updatePlanSchedule(plan.id, {
        last_run_slot: slot,
        last_run_at: new Date().toISOString(),
        last_result: result?.success === false ? 'failed' : 'success',
        last_error: result?.success === false ? '一个或多个环境执行失败' : '',
      });
      this.emit({ type: 'rpa-schedule', planId: plan.id, state: result?.success === false ? 'failed' : 'success' });
    } catch (error) {
      await this.updatePlanSchedule(plan.id, {
        last_run_slot: slot,
        last_run_at: new Date().toISOString(),
        last_result: 'failed',
        last_error: String(error?.message || error),
      }).catch(() => {});
      this.emit({ type: 'rpa-schedule', planId: plan.id, state: 'failed', message: String(error?.message || error) });
    } finally {
      this.runningPlans.delete(plan.id);
    }
  }

  async tick(now = new Date()) {
    const slot = localMinuteSlot(now);
    const launches = [];
    for (const plan of this.store.listPlans()) {
      const schedule = plan.schedule || {};
      if (!schedule.enabled || !schedule.cron || schedule.last_run_slot === slot || this.runningPlans.has(plan.id)) continue;
      let matches = false;
      try {
        matches = cronMatches(schedule.cron, now);
      } catch (error) {
        this.emit({ type: 'rpa-schedule', planId: plan.id, state: 'invalid', message: error.message });
        continue;
      }
      if (!matches) continue;
      // Persist the slot before execution so a restart or a second scheduler
      // tick in the same minute cannot duplicate the run.
      await this.updatePlanSchedule(plan.id, {
        last_run_slot: slot,
        last_run_at: now.toISOString(),
        last_result: 'running',
        last_error: '',
      });
      launches.push(this.runScheduledPlan(plan, slot));
    }
    await Promise.all(launches);
    return { triggered: launches.length, slot };
  }
}

module.exports = {
  RpaScheduler,
  compileCron,
  cronMatches,
  localMinuteSlot,
  normalizeSchedule,
};
