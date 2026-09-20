import { useEffect, useRef } from 'react';
import type { Cue } from '../types';
import { secondsToSrtTime } from '../lib/srt';
import type { DriftPlan } from '../lib/drift';

interface DriftPanelProps {
  /** 区间字幕（按时间排序，含两端） */
  range: Cue[];
  /** 输入框原始文本（状态归 App 所有，取消即丢弃） */
  targetStartRaw: string;
  targetEndRaw: string;
  onTargetStartChange: (v: string) => void;
  onTargetEndChange: (v: string) => void;
  /** 依据当前输入实时算出的计划（含冲突）；区间失效时 null */
  plan: DriftPlan | null;
  onApply: () => void;
  onCancel: () => void;
  /** 存在冲突时定位首个冲突（时间轴滚动 + 列表选中） */
  onLocateConflict: () => void;
}

/**
 * 区间漂移校准面板（停靠在舞台底部，跟读面板之上）：
 * Shift 在字幕列表框选连续区间后出现；输入目标锚点即时重算线性映射，
 * 时间轴同步显示旧/新位置预览与缩放比例；有冲突禁止提交并可定位首个冲突。
 */
export default function DriftPanel({
  range,
  targetStartRaw,
  targetEndRaw,
  onTargetStartChange,
  onTargetEndChange,
  plan,
  onApply,
  onCancel,
  onLocateConflict
}: DriftPanelProps) {
  const startInputRef = useRef<HTMLInputElement | null>(null);

  // 区间变化（新的框选）时焦点回到起点输入，便于直接键入
  useEffect(() => {
    startInputRef.current?.focus();
    startInputRef.current?.select();
    // range 身份在每次重新框选时变化
  }, [range]);

  const first = range[0];
  const last = range[range.length - 1];
  const conflict = plan?.conflict ?? null;
  const valid = !!plan && !conflict;

  const originSpan = plan ? plan.originEnd - plan.originStart : 0;
  const targetSpan = plan && Number.isFinite(plan.targetEnd) && Number.isFinite(plan.targetStart)
    ? plan.targetEnd - plan.targetStart
    : null;
  const scale = plan && Number.isFinite(plan.scale) ? plan.scale : null;

  // Enter 在输入框中：合法则提交，有冲突则定位首个冲突
  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (valid) onApply();
    else if (conflict) onLocateConflict();
  };

  return (
    <div className="drift-dock">
      <div className="drift-head">
        <span className="drift-title">📐 区间漂移校准</span>
        <span className="drift-range-info">
          区间 {range.length} 条：第 1 条起 {secondsToSrtTime(first.start)} → 末条止 {secondsToSrtTime(last.end)}
        </span>
      </div>
      <div className="drift-body">
        <div className="drift-anchors">
          <label className="drift-anchor" title="原始起点 = 区间首条字幕的起点">
            <span className="drift-anchor-name">起点锚点</span>
            <span className="drift-origin">{secondsToSrtTime(first.start)}</span>
            <span className="drift-arrow">→</span>
            <input
              ref={startInputRef}
              className="drift-input"
              value={targetStartRaw}
              spellCheck={false}
              placeholder="00:00:00,000"
              onChange={(e) => onTargetStartChange(e.target.value)}
              onKeyDown={onInputKeyDown}
            />
          </label>
          <label className="drift-anchor" title="原始终点 = 区间末条字幕的终点">
            <span className="drift-anchor-name">终点锚点</span>
            <span className="drift-origin">{secondsToSrtTime(last.end)}</span>
            <span className="drift-arrow">→</span>
            <input
              className="drift-input"
              value={targetEndRaw}
              spellCheck={false}
              placeholder="00:00:00,000"
              onKeyDown={onInputKeyDown}
              onChange={(e) => onTargetEndChange(e.target.value)}
            />
          </label>
        </div>

        <div className={['drift-stats', conflict ? 'has-conflict' : valid ? 'ok' : ''].join(' ').trim()}>
          <span className="drift-stat">
            原区间 <strong>{originSpan.toFixed(3)}s</strong>
          </span>
          <span className="drift-arrow">→</span>
          <span className="drift-stat">
            新区间 <strong>{targetSpan === null ? '—' : `${targetSpan.toFixed(3)}s`}</strong>
          </span>
          <span className="drift-scale" title="缩放比例 = 新区间长度 / 原区间长度，区间内所有起止时间同一线性映射">
            缩放 <strong>{scale === null ? '—' : `${scale.toFixed(4)}×`}</strong>
            {scale !== null && <em className="drift-scale-pct">（{(scale * 100).toFixed(1)}%）</em>}
          </span>
        </div>

        {conflict ? (
          <div className="drift-conflict">
            <span className="drift-conflict-msg">⛔ {conflict.message}</span>
            <button className="btn mini" onClick={onLocateConflict} disabled={conflict.time === null}>
              {conflict.time === null ? '无位置可定位' : '定位首个冲突'}
            </button>
          </div>
        ) : (
          <div className="drift-ok-hint">
            {valid
              ? '✓ 映射通过最短时长 / 最小间隔校验，时间轴上虚框为旧位置、亮色块为映射后位置'
              : '输入目标锚点时间后实时预览（支持 00:01:23,500 或纯秒数 12.5）'}
          </div>
        )}

        <div className="drift-actions">
          <button className="btn primary" onClick={onApply} disabled={!valid} title={conflict ? conflict.message : '以一次历史记录提交本次区间漂移'}>
            提交校准
          </button>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <span className="drift-tip">提交后可整体撤销 / 重做，并随 SRT 导出；取消或切换文件将清空预览</span>
        </div>
      </div>
    </div>
  );
}
