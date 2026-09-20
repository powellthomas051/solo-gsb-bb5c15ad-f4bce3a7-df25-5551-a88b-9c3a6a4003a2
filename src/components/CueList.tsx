import { useEffect, useRef } from 'react';
import type { Cue } from '../types';
import { secondsToSrtTime } from '../lib/srt';

interface CueListProps {
  cues: Cue[];
  currentTime: number;
  /** 当前单条选中（A-B 循环 / 跟读所跟随的字幕） */
  selectedId: string | null;
  /** 漂移框选 / 高亮的区间字幕 id */
  rangeIds?: ReadonlySet<string>;
  /** 漂移区间锚点（首条）id，用于行首标记 */
  anchorId?: string | null;
  /** 是否存在漂移框选（决定「区间漂移」入口的文案） */
  hasDriftRange?: boolean;
  onSelect: (id: string, additive: boolean) => void;
  /** 以当前区间开启漂移面板（无 Shift 选区时对当前单条选中开启） */
  onStartDrift: () => void;
  onSeek: (t: number) => void;
}

export default function CueList({
  cues,
  currentTime,
  selectedId,
  rangeIds,
  anchorId,
  hasDriftRange,
  onSelect,
  onStartDrift,
  onSeek
}: CueListProps) {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const rangeFirstRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // 开启 / 切换漂移框选时，把区间首条滚入视野（定位冲突时由调用方先改 selectedId，
  // 本效应只在区间首条变化时触发，避免与冲突定位抢滚动）
  const rangeFirstId = rangeIds && rangeIds.size > 0
    ? sorted.find((c) => rangeIds.has(c.id))?.id ?? null
    : null;
  useEffect(() => {
    if (rangeFirstId && !rangeIds?.has(selectedId ?? '')) {
      rangeFirstRef.current?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeFirstId]);

  return (
    <aside className="cue-list">
      <div className="cue-list-head">
        <span>
          字幕列表（{sorted.length}）
          <span className="hint">点击选中 · Shift+点击框选连续区间</span>
        </span>
        <button
          className="btn mini drift-entry"
          disabled={!selectedId}
          title={
            selectedId
              ? '先在列表 Shift+点击选择连续区间（不选则仅当前一条），再开启区间漂移校准'
              : '请先点击选择一条字幕'
          }
          onClick={onStartDrift}
        >
          📐 {hasDriftRange ? '漂移区间' : '区间漂移'}
        </button>
      </div>
      <div className="cue-list-body">
        {sorted.length === 0 && <div className="empty">尚未导入 SRT 文件</div>}
        {sorted.map((cue, i) => {
          const active = currentTime >= cue.start && currentTime < cue.end;
          const inRange = !!rangeIds?.has(cue.id);
          const isAnchor = cue.id === anchorId;
          return (
            <div
              key={cue.id}
              ref={
                cue.id === selectedId
                  ? selectedRef
                  : cue.id === rangeFirstId
                    ? rangeFirstRef
                    : null
              }
              className={[
                'cue-row',
                cue.id === selectedId && 'selected',
                inRange && 'in-drift-range',
                isAnchor && 'drift-anchor',
                active && 'playing'
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={(e) => onSelect(cue.id, e.shiftKey)}
            >
              <div className="cue-row-index">
                {isAnchor && <span className="drift-anchor-tag" title="漂移区间首条（起点锚点）">◆</span>}
                {i + 1}
              </div>
              <button
                className="cue-row-time"
                title="定位到该字幕（Shift+点击可框选区间）"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(cue.id, e.shiftKey);
                  if (!e.shiftKey) onSeek(cue.start);
                }}
              >
                {secondsToSrtTime(cue.start)}
                <br />
                {secondsToSrtTime(cue.end)}
              </button>
              <div className="cue-row-text">{cue.text}</div>
              <div className="cue-row-dur">{(cue.end - cue.start).toFixed(2)}s</div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
