/**
 * 区间漂移校准：线性映射与冲突判定（纯函数，可单测）。
 *
 * 用户在字幕列表 Shift 选择一个连续区间，以首条起点 / 末条终点为原始锚点，
 * 输入各自的目标时间后，区间内每条字幕的所有起止时间都套用同一线性映射：
 *
 *   t' = targetStart + (t - originStart) * (targetEnd - targetStart) / (originEnd - originStart)
 *
 * 提交前需通过：目标锚点非倒序、映射后不越过 0s、每条不短于最短时长、
 * 与区间内外相邻字幕保持最小间隔（含重叠）。任一不满足返回首个冲突。
 */
import type { Constraints, Cue } from '../types';

/** 漂移输入文本解析结果（秒） */
export function parseDriftInput(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  // 纯秒：3.5 / 12 / 00:00:01,500 之外的直接秒数写法
  if (/^\d+(\.\d+)?$/.test(s)) {
    const v = Number(s);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  // mm:ss / mm:ss.fff（秒内最多 3 位）
  let m = s.match(/^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (m) {
    const mm = Number(m[1]);
    const ss = Number(m[2]);
    if (ss >= 60) return null;
    const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
    const v = mm * 60 + ss + ms / 1000;
    return v >= 0 ? v : null;
  }
  // hh:mm:ss / hh:mm:ss.fff
  m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = Number(m[3]);
    if (mm >= 60 || ss >= 60) return null;
    const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
    const v = hh * 3600 + mm * 60 + ss + ms / 1000;
    return v >= 0 ? v : null;
  }
  return null;
}

/** 输入框回显：秒 -> 00:00:00,000（与 SRT 时间码一致） */
export function formatDriftInput(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '';
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)},${String(ms).padStart(3, '0')}`;
}

/** 解析 Shift 选区：返回按时间排序的区间内字幕（含两端）；端点缺失时 null */
export function resolveDriftRange(cues: Cue[], firstId: string, lastId: string): Cue[] | null {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const i = sorted.findIndex((c) => c.id === firstId);
  const j = sorted.findIndex((c) => c.id === lastId);
  if (i < 0 || j < 0) return null;
  return sorted.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** 冲突类别（用于时间轴着色 / 定位） */
export type DriftConflictKind =
  | 'bad-input'
  | 'target-negative'
  | 'target-order'
  | 'new-negative'
  | 'duration'
  | 'gap-prev'
  | 'gap-next';

export interface DriftConflict {
  kind: DriftConflictKind;
  message: string;
  /** 冲突所属区间内字幕（倒序 / 输入非法时为 null） */
  cueId: string | null;
  /** 定位时间（秒）：取冲突字幕的映射起点；无所属字幕时取目标起点 */
  time: number | null;
}

export interface DriftMappedCue {
  cue: Cue;
  newStart: number;
  newEnd: number;
  /** 区间内序号（从 1 开始，按时间排序） */
  index: number;
}

export interface DriftPlan {
  range: Cue[];
  originStart: number;
  originEnd: number;
  targetStart: number;
  targetEnd: number;
  /** 缩放比例 = 新区间长度 / 原区间长度（>0） */
  scale: number;
  mapped: DriftMappedCue[];
  conflict: DriftConflict | null;
}

function round3(t: number): number {
  return Math.round(t * 1000) / 1000;
}

/**
 * 依据原始 / 目标锚点构造映射计划并做全量校验。
 *
 * 校验顺序即「首个冲突」的优先级：
 * 1. 目标输入非法（无法解析 / 为负）；
 * 2. 目标锚点倒序（targetEnd <= targetStart）；
 * 3. 首条映射起点越过 0s；
 * 4. 与区间外上一条字幕重叠 / 间隔不足；
 * 5. 区间内顺序推进：每条时长 ≥ 最短时长、与后一条间隔 ≥ 最小间隔；
 * 6. 末条与区间外下一条字幕重叠 / 间隔不足。
 */
export function buildDriftPlan(
  cues: Cue[],
  firstId: string,
  lastId: string,
  rawTargetStart: string,
  rawTargetEnd: string,
  constraints: Constraints
): DriftPlan | null {
  const range = resolveDriftRange(cues, firstId, lastId);
  if (!range || range.length === 0) return null;

  const first = range[0];
  const last = range[range.length - 1];
  const originStart = first.start;
  const originEnd = last.end;
  const originSpan = originEnd - originStart; // 合法 SRT 保证 > 0

  const targetStart = parseDriftInput(rawTargetStart);
  const targetEnd = parseDriftInput(rawTargetEnd);

  const base = {
    range,
    originStart,
    originEnd,
    targetStart: targetStart ?? NaN,
    targetEnd: targetEnd ?? NaN,
    scale: NaN,
    mapped: [],
    conflict: null as DriftConflict | null
  };

  if (targetStart === null) {
    return {
      ...base,
      conflict: {
        kind: 'bad-input',
        message: '目标起点时间无法识别，请使用如 00:01:23,500 或 12.5 的格式',
        cueId: null,
        time: null
      }
    };
  }
  if (targetEnd === null) {
    return {
      ...base,
      conflict: {
        kind: 'bad-input',
        message: '目标终点时间无法识别，请使用如 00:01:23,500 或 12.5 的格式',
        cueId: null,
        time: null
      }
    };
  }
  if (targetStart < 0) {
    return {
      ...base,
      conflict: { kind: 'target-negative', message: '目标起点不能为负', cueId: null, time: null }
    };
  }
  if (targetEnd <= targetStart) {
    return {
      ...base,
      conflict: {
        kind: 'target-order',
        message: `目标锚点倒序：终点 ${formatDriftInput(targetEnd)} 不晚于起点 ${formatDriftInput(
          targetStart
        )}`,
        cueId: null,
        time: targetStart
      }
    };
  }

  const targetSpan = targetEnd - targetStart;
  const scale = targetSpan / originSpan;
  const mapTime = (t: number): number => round3(targetStart + (t - originStart) * scale);

  const sortedAll = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const rangeIds = new Set(range.map((c) => c.id));
  const firstIdx = sortedAll.findIndex((c) => c.id === first.id);
  const lastIdx = sortedAll.findIndex((c) => c.id === last.id);
  const outerPrev = sortedAll.slice(0, firstIdx).reverse().find((c) => !rangeIds.has(c.id)) ?? null;
  const outerNext = sortedAll.slice(lastIdx + 1).find((c) => !rangeIds.has(c.id)) ?? null;

  const mapped: DriftMappedCue[] = range.map((cue, i) => ({
    cue,
    newStart: mapTime(cue.start),
    newEnd: mapTime(cue.end),
    index: i + 1
  }));

  const ready = { ...base, targetStart, targetEnd, scale, mapped };

  // 3. 越过 0s（scale > 0，仅需检查首条起点）
  if (mapped[0].newStart < 0) {
    return {
      ...ready,
      conflict: {
        kind: 'new-negative',
        message: `映射后第 1 条起点 ${mapped[0].newStart.toFixed(3)}s 越过时间轴起点 00:00.000`,
        cueId: first.id,
        time: Math.max(0, mapped[0].newStart)
      }
    };
  }

  // 4. 与区间外上一条：重叠优先于间隔不足
  if (outerPrev) {
    const ns = mapped[0].newStart;
    if (ns < outerPrev.end) {
      return {
        ...ready,
        conflict: {
          kind: 'gap-prev',
          message: `映射后第 1 条与区间外上一条字幕（结束 ${formatDriftInput(
            outerPrev.end
          )}）发生重叠`,
          cueId: first.id,
          time: ns
        }
      };
    }
    if (round3(ns - outerPrev.end) < constraints.minGap) {
      return {
        ...ready,
        conflict: {
          kind: 'gap-prev',
          message: `映射后第 1 条与区间外上一条间隔 ${(ns - outerPrev.end).toFixed(
            3
          )}s 小于最小间隔 ${constraints.minGap.toFixed(3)}s`,
          cueId: first.id,
          time: ns
        }
      };
    }
  }

  // 5. 区间内：第 i 条时长 + 与第 i+1 条间隔
  for (let i = 0; i < mapped.length; i++) {
    const m = mapped[i];
    const dur = round3(m.newEnd - m.newStart);
    if (dur < constraints.minDuration) {
      return {
        ...ready,
        conflict: {
          kind: 'duration',
          message: `映射后第 ${m.index} 条时长 ${dur.toFixed(3)}s 短于最短时长 ${constraints.minDuration.toFixed(
            3
          )}s`,
          cueId: m.cue.id,
          time: m.newStart
        }
      };
    }
    const nxt = mapped[i + 1];
    if (nxt) {
      const gap = round3(nxt.newStart - m.newEnd);
      if (gap < 0) {
        return {
          ...ready,
          conflict: {
            kind: 'gap-next',
            message: `映射后第 ${m.index} 条与第 ${nxt.index} 条发生重叠`,
            cueId: m.cue.id,
            time: m.newStart
          }
        };
      }
      if (gap < constraints.minGap) {
        return {
          ...ready,
          conflict: {
            kind: 'gap-next',
            message: `映射后第 ${m.index} 条与第 ${nxt.index} 条间隔 ${gap.toFixed(
              3
            )}s 小于最小间隔 ${constraints.minGap.toFixed(3)}s`,
            cueId: m.cue.id,
            time: m.newStart
          }
        };
      }
    }
  }

  // 6. 与区间外下一条
  if (outerNext) {
    const ne = mapped[mapped.length - 1].newEnd;
    if (outerNext.start < ne) {
      return {
        ...ready,
        conflict: {
          kind: 'gap-next',
          message: `映射后末条与区间外下一条字幕（起点 ${formatDriftInput(
            outerNext.start
          )}）发生重叠`,
          cueId: last.id,
          time: mapped[mapped.length - 1].newStart
        }
      };
    }
    if (round3(outerNext.start - ne) < constraints.minGap) {
      return {
        ...ready,
        conflict: {
          kind: 'gap-next',
          message: `映射后末条与区间外下一条间隔 ${(outerNext.start - ne).toFixed(
            3
          )}s 小于最小间隔 ${constraints.minGap.toFixed(3)}s`,
          cueId: last.id,
          time: mapped[mapped.length - 1].newStart
        }
      };
    }
  }

  return ready;
}

/** 把合法计划落到字幕数组上（不可变），区间外字幕保持不变 */
export function applyDriftPlan(cues: Cue[], plan: DriftPlan): Cue[] {
  const byId = new Map(plan.mapped.map((m) => [m.cue.id, m]));
  return cues.map((c) => {
    const m = byId.get(c.id);
    return m ? { ...c, start: m.newStart, end: m.newEnd } : c;
  });
}
