import { parseSrt, serializeSrt, secondsToSrtTime, srtTimeToSeconds } from '../src/lib/srt';
import { validateEdge, applyEdge, initHistory, commitHistory, undoHistory, redoHistory } from '../src/lib/cues';
import {
  analyzeChannels,
  computeWindowLevels,
  detectSilences,
  MERGE_GAP,
  MIN_SILENCE_DURATION,
  nearestSilenceEdge,
  resolveEdgeCandidate,
  SNAP_RADIUS,
  WINDOW_SIZE
} from '../src/lib/silence';
import {
  computeLoopRange,
  DEFAULT_LOOP_MARGINS,
  loopDisableReason,
  loopDisableText,
  loopEntryTarget,
  loopWrapTarget,
  MIN_LOOP_LENGTH
} from '../src/lib/abLoop';
import {
  SHADOW_DRIFT_LIMIT,
  clampRelative,
  describeGetUserMediaError,
  hasRecordingSupport,
  needsDriftCorrection,
  pickRecorderMimeType,
  trackDrift
} from '../src/lib/shadow';
import {
  applyDriftPlan,
  buildDriftPlan,
  formatDriftInput,
  parseDriftInput,
  resolveDriftRange
} from '../src/lib/drift';

let fail = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.error('❌', msg);
  } else {
    console.log('✅', msg);
  }
}

// 1. 时间格式往返
assert(secondsToSrtTime(0) === '00:00:00,000', '0 序列化');
assert(secondsToSrtTime(3661.5) === '01:01:01,500', '3661.5 序列化');
assert(srtTimeToSeconds('00:00:01,500') === 1.5, '逗号毫秒解析');
assert(srtTimeToSeconds('00:00:01.5') === 1.5, '点毫秒解析（容错）');

// 2. 解析含 BOM / CRLF / 缺序号的 SRT
const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,000\r\n你好\r\n\r\n' +
  '00:00:04.000 --> 00:00:06,500\r\n第二行\r\n第二行续\r\n\r\n' +
  'bad block\r\n\r\n' +
  '3\r\n00:00:10,000 --> 00:00:09,000\r\n逆序应跳过\r\n';
const { cues, warnings } = parseSrt(srt);
assert(cues.length === 2, `解析出 2 条（实际 ${cues.length}）`);
assert(warnings.length === 2, `产生 2 条告警（实际 ${warnings.length}）`);
assert(cues[0].text === '你好', '第一条文本');
assert(cues[1].start === 4 && cues[1].end === 6.5, '点分隔第二块');

// 3. 导出保持时间顺序且重新连续编号
cues[0].start = 100; // 打乱顺序后导出
const out = serializeSrt(cues);
const nums = [...out.matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]));
assert(JSON.stringify(nums) === '[1,2]', `导出编号连续 1,2（实际 ${JSON.stringify(nums)}）`);
assert(out.startsWith('1\n00:00:04,000'), '导出按时间升序，最早者编号 1');

// 4. 约束校验
const C = { minDuration: 0.5, minGap: 0.1 };
let r = validateEdge(cues, cues[0].id, 'start', -1, C);
assert(!r.ok && r.message.includes('00:00'), '左边界越过 0 被拒绝');
const base = [
  { id: 'a', start: 1, end: 2, text: 'a' },
  { id: 'b', start: 3, end: 4, text: 'b' }
];
r = validateEdge(base, 'a', 'end', 2.95, C);
assert(!r.ok && r.message.includes('间隔'), `间隔 0.05 < 0.1 被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 3.2, C);
assert(!r.ok && r.message.includes('重叠'), `重叠被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 1.4, C);
assert(!r.ok && r.message.includes('短于最短时长'), '时长不足被拒绝');
r = validateEdge(base, 'a', 'end', 2.9, C);
assert(r.ok, '间隔恰好 0.1 合法');
r = validateEdge(base, 'b', 'start', 2.1, C);
assert(r.ok, '右块左边界贴到 2.1 合法');
r = validateEdge(base, 'b', 'start', 2.05, C);
assert(!r.ok, '右块左边界间隔不足被拒绝');

// 5. 应用变更 & 撤销重做
let h = initHistory(base);
const next = applyEdge(base, 'a', 'end', 2.5);
h = commitHistory(h, next);
assert(h.present[0].end === 2.5 && h.past.length === 1, '提交边界调整');
h = undoHistory(h);
assert(h.present[0].end === 2 && h.future.length === 1, '撤销恢复');
h = redoHistory(h);
assert(h.present[0].end === 2.5, '重做再次应用');
h = commitHistory(h, applyEdge(h.present, 'a', 'end', 2.8));
assert(h.future.length === 0, '新提交清空 redo 栈');

// 6. 静音检测：窗口 RMS（各声道取最大）
function tone(samples: number, v: number): Float32Array {
  return new Float32Array(samples).fill(v);
}
// 1s 单声道：0~0.3s 有声(0.5)，0.3~0.6s 静音，0.6~1.0s 有声(0.3)
{
  const sr = 1000;
  const ch = new Float32Array(sr);
  ch.fill(0.3, 0, sr);
  ch.fill(0.5, 0, 300);
  ch.fill(0, 300, 600);
  const win = computeWindowLevels([ch], sr);
  assert(win.windowSize === WINDOW_SIZE, `窗口为 ${WINDOW_SIZE}s`);
  assert(win.levels.length === 50, `1s / 20ms = 50 窗口（实际 ${win.levels.length}）`);
  assert(win.levels[0] === 0.5, '有声窗口 RMS=0.5');
  assert(win.levels[20] === 0, '静音窗口 RMS=0');
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 1, `检测出 1 段静音（实际 ${segs.length}）`);
  assert(segs[0].start === 0.3 && segs[0].end === 0.6, `静音段 0.3~0.6（实际 ${segs[0].start}~${segs[0].end}）`);
}

// 7. 各声道取最大值：一声道静音、另一声道有声 => 窗口不判静音
{
  const sr = 1000;
  const silent = new Float32Array(sr); // 全 0
  const loud = new Float32Array(sr).fill(0.2);
  const win = computeWindowLevels([silent, loud], sr);
  assert(Math.abs(win.levels[10] - 0.2) < 1e-6, '双声道取 RMS 最大值 0.2');
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 0, '任一非静音声道则整窗口非静音');
}

// 8. 短于 200ms 的静音不成段；恰好 200ms 合法
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.2);
  ch.fill(0, 100, 250); // 150ms 静音
  ch.fill(0, 400, 600); // 200ms 静音
  const win = computeWindowLevels([ch], sr);
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 1, `仅 200ms 段保留（实际 ${segs.length} 段）`);
  assert(segs[0].start === 0.4 && segs[0].end === 0.6, `保留 0.4~0.6 段（实际 ${segs[0].start}~${segs[0].end}）`);
  assert(MIN_SILENCE_DURATION === 0.2, '最短静音默认 200ms');
}

// 9. 间隔不足 80ms 的两段先合并；恰好 80ms 不合并
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.2);
  ch.fill(0, 0, 200); // 200ms
  ch.fill(0, 260, 460); // 间隔 60ms，应合并
  ch.fill(0, 540, 740); // 与上段间隔恰好 80ms，不合并
  const win = computeWindowLevels([ch], sr);
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 2, `合并后 2 段（实际 ${segs.length}）`);
  assert(segs[0].start === 0 && segs[0].end === 0.46, `60ms 间隔被合并为 0~0.46（实际 0~${segs[0].end}）`);
  assert(segs[1].start === 0.54 && segs[1].end === 0.74, '80ms 间隔不合并');
  assert(MERGE_GAP === 0.08, '合并间隔默认 80ms');
}

// 10. 阈值严格小于判定：RMS 恰好等于阈值不算静音
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.01);
  const win = computeWindowLevels([ch], sr);
  assert(detectSilences(win, { threshold: 0.01 }).length === 0, 'RMS 等于阈值不判静音');
  const ch2 = new Float32Array(sr).fill(0.009);
  const win2 = computeWindowLevels([ch2], sr);
  assert(detectSilences(win2, { threshold: 0.01 }).length === 1, 'RMS 低于阈值判静音');
}

// 11. analyzeChannels 端到端 + 可调阈值重新分段
{
  const sr = 1000;
  const ch = new Float32Array(sr);
  ch.fill(0.05, 0, 400);
  ch.fill(0, 400, 800);
  ch.fill(0.05, 800, 1000);
  const low = analyzeChannels([ch], sr, { threshold: 0.01 });
  assert(low.segments.length === 1 && low.segments[0].start === 0.4, '低阈值：只检出真静音');
  const high = detectSilences(low, { threshold: 0.06 });
  // 首尾 0.05 弱信号段（0~0.4 与 0.8~1.0）也低于阈值，与真静音合并为整段
  assert(high.length === 1 && high[0].start === 0 && high[0].end === 1, `调高阈值：弱信号段也算静音并合并（实际 ${high[0]?.start}~${high[0]?.end}）`);
}

// 12. 最近静音边缘：150ms 半径、等距取更早者
const sil = [
  { start: 1.0, end: 2.0 },
  { start: 3.0, end: 4.0 }
];
assert(SNAP_RADIUS === 0.15, '吸附半径默认 150ms');
let e = nearestSilenceEdge(sil, 1.1);
assert(e?.time === 1.0, '靠近 1.0 起点吸附');
e = nearestSilenceEdge(sil, 1.9);
assert(e?.time === 2.0 && e.side === 'end', '靠近 2.0 终点吸附');
e = nearestSilenceEdge(sil, 2.5);
assert(e === null, '超出 150ms 无吸附');
e = nearestSilenceEdge(sil, 1.15);
assert(e === null, '恰好 150ms 边界外不吸附（严格小于半径）');
// 相邻两段 [1,2]、[3,4]：2.5 距两个边缘都是 0.5，取更早者 2.0
e = nearestSilenceEdge(sil, 2.5, 0.6);
assert(e?.time === 2.0, '等距时取更早边缘（2.0 而非 3.0）');

// 13. resolveEdgeCandidate：吸附合法 / 吸附不合法回退 / 开关关闭
const dragCues = [
  { id: 'a', start: 0.2, end: 1.0, text: 'a' },
  { id: 'b', start: 2.3, end: 3.0, text: 'b' }
];
const DC = { minDuration: 0.5, minGap: 0.1 };
// 右边界拖到 1.91（距 2.0 终点 90ms），吸附到 2.0：与 b(2.3) 间隔 0.3 合法
let rr = resolveEdgeCandidate(dragCues, 'a', 'end', 1.91, DC, sil, true);
assert(rr.snapped && rr.time === 2.0 && rr.valid, `吸附到合法静音边缘 2.0（snapped=${rr.snapped}）`);
// 吸附点违反最短时长：a 时长要求 1.0s；从 0.91 吸附到 1.0 时时长恰 0.8s
// 改用 minDuration 0.95 且原始候选 0.91（时长 0.71，本身也非法，验证回退原因）
const DC2 = { minDuration: 0.95, minGap: 0.1 };
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 0.91, DC2, sil, true);
assert(!rr.snapped && rr.time === 0.91 && !!rr.snapRejected, '吸附点违反最短时长 -> 回退未吸附候选并带原因');
assert(rr.snapRejected?.includes('短于最短时长'), `回退原因指明时长：${rr.snapRejected ?? ''}`);
assert(rr.valid === false, '回退后的候选（时长 0.71<0.95）本身仍非法');
// 吸附点合法但另一约束不合法时不影响：吸附到 1.0 在 DC 下时长 0.8、与邻居无冲突
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 0.91, DC, sil, true);
assert(rr.snapped && rr.time === 1.0 && rr.valid, '吸附到 1.0（时长 0.8 ≥ 0.5）合法');
// 吸附点违反最小间隔：拖 a 右边界到 2.91 附近，吸附到 3.0 会与 b 重叠
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 2.91, DC, sil, true);
assert(!rr.snapped && (rr.snapRejected?.includes('重叠') || rr.snapRejected?.includes('间隔')), `吸附点重叠/间隔不足回退：${rr.snapRejected ?? ''}`);
// 回退后未吸附候选仍合法的情形：静音段 [1.5,2.16] 终点 2.16 距 b(2.3) 仅 0.14
// （间隔不足 0.1 否……改为段终点 2.25）；拖动 a 右边界到 2.12（合法，间隔 0.18），
// 距 2.25 为 0.13 会吸附，但 2.25 与 b 间隔仅 0.05 -> 吸附非法，回退保留 2.12
const sil2 = [{ start: 1.5, end: 2.25 }];
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 2.12, DC, sil2, true);
assert(!rr.snapped && rr.time === 2.12 && rr.valid && !!rr.snapRejected, '吸附非法但原候选合法：回退保留 2.12 并提示');
assert(rr.snapRejected?.includes('间隔'), `回退原因为间隔不足：${rr.snapRejected ?? ''}`);
// 开关关闭：即使在半径内也不吸附
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 1.91, DC, sil, false);
assert(!rr.snapped && rr.time === 1.91, '吸附关闭时保留原始候选');
// 原始候选非法但吸附点合法：短块 b(2.3~2.6) 左边界拖到 2.14（时长 0.46 不足），
// 距静音边缘 2.0 为 0.14，吸附后时长 0.6 合法
const dragCues2 = [
  { id: 'a', start: 0.2, end: 1.0, text: 'a' },
  { id: 'b', start: 2.3, end: 2.6, text: 'b' }
];
rr = resolveEdgeCandidate(dragCues2, 'b', 'start', 2.14, DC, sil, true);
assert(rr.snapped && rr.time === 2.0 && rr.valid, '原候选时长不足但吸附到 2.0 合法');

// 14. A-B 循环：区间计算（余量、裁剪、空区间）
{
  const cue = { start: 2, end: 4 };
  let lr = computeLoopRange(cue, { pre: 0.5, post: 0.25 }, 10);
  assert(lr?.a === 1.5 && lr?.b === 4.25, `循环区间加余量（实际 ${lr?.a}~${lr?.b}）`);
  lr = computeLoopRange({ start: 0.2, end: 1 }, { pre: 0.5, post: 0 }, 10);
  assert(lr?.a === 0, 'A 点不越过 0s');
  lr = computeLoopRange({ start: 8, end: 9.8 }, { pre: 0, post: 0.5 }, 10);
  assert(lr?.b === 10, 'B 点裁剪到音频时长');
  lr = computeLoopRange({ start: 12, end: 13 }, { pre: 0.3, post: 0.3 }, 10);
  assert(lr === null, '区间整体超出音频时长 -> 空');
  lr = computeLoopRange({ start: 9.98, end: 10.5 }, { pre: 0, post: 0 }, 10);
  assert(lr === null, `裁剪后不足 ${MIN_LOOP_LENGTH}s -> 空`);
  lr = computeLoopRange(null, { pre: 0.3, post: 0.3 }, 10);
  assert(lr === null, '无选中字幕 -> 无区间');
  lr = computeLoopRange(cue, { pre: -1, post: -1 }, 10);
  assert(lr?.a === 2 && lr?.b === 4, '负余量按 0 处理');
  lr = computeLoopRange({ start: 8, end: 9 }, { pre: 0, post: 0.5 }, 0);
  assert(lr?.b === 9.5, '时长未知（0）时不裁剪 B');
  assert(DEFAULT_LOOP_MARGINS.pre >= 0 && DEFAULT_LOOP_MARGINS.post >= 0, '默认余量非负');
}

// 15. A-B 循环：禁用原因优先级与文案
{
  const cue = { start: 2, end: 4 };
  const range = { a: 1.5, b: 4.25 };
  assert(loopDisableReason(false, cue, range) === 'no-audio', '无音频禁用');
  assert(loopDisableReason(true, null, null) === 'no-selection', '未选字幕禁用');
  assert(loopDisableReason(true, cue, null) === 'empty-range', '区间为空禁用');
  assert(loopDisableReason(true, cue, range) === null, '条件满足可开启');
  assert(loopDisableReason(false, null, null) === 'no-audio', '无音频优先于未选字幕');
  assert(loopDisableText('empty-range').includes('裁剪'), '空区间原因说明裁剪');
}

// 16. A-B 循环：播放状态转换（越过 B 回 A / 进入新区间校正）
{
  const range = { a: 1, b: 4 };
  assert(loopWrapTarget(3.9, range) === null, '未越过 B 不干预');
  assert(loopWrapTarget(4, range) === 1, '恰好到 B 回 A');
  assert(loopWrapTarget(4.2, range) === 1, '越过 B 回 A');
  assert(loopWrapTarget(5, null) === null, '无区间不干预');
  assert(loopEntryTarget(0.5, range) === 1, '落在新区间之前 -> 跳到新 A');
  assert(loopEntryTarget(5, range) === 1, '落在新区间之后 -> 跳到新 A');
  assert(loopEntryTarget(2, range) === null, '区间内不动播放头');
  assert(loopEntryTarget(1, range) === null, '恰在 A 不动');
  assert(loopEntryTarget(4, range) === null, '恰在 B 不动（播放推进由回卷处理）');
  assert(loopEntryTarget(0.5, null) === null, '无区间不校正');
}

// 17. 单句跟读：能力检测、时钟偏差与纠偏阈值
{
  assert(!hasRecordingSupport(undefined, undefined), '无 mediaDevices / MediaRecorder -> 不支持');
  assert(
    !hasRecordingSupport({ getUserMedia: 1 }, function MediaRecorder() {}),
    'getUserMedia 非函数 -> 不支持'
  );
  assert(
    hasRecordingSupport({ getUserMedia: () => undefined }, function MediaRecorder() {}),
    '两者皆为函数 -> 支持录音'
  );
  assert(SHADOW_DRIFT_LIMIT === 0.08, '偏差阈值 80ms');

  assert(Math.abs(trackDrift(1, 0.9) - 0.1) < 1e-9, '录音滞后 100ms -> 偏差 +0.1');
  assert(Math.abs(trackDrift(0.9, 1) - -0.1) < 1e-9, '录音超前 100ms -> 偏差 -0.1');
  assert(!needsDriftCorrection(0.08), '恰好 80ms 不纠偏（严格大于）');
  assert(needsDriftCorrection(0.081), '超过 80ms 触发纠偏');
  assert(needsDriftCorrection(-0.09), '超前超过 80ms 同样纠偏');
  assert(!needsDriftCorrection(0.02), '20ms 不干预');

  assert(clampRelative(-1, 2) === 0, '相对时间负值夹到 0');
  assert(clampRelative(3, 2) === 2, '相对时间超出时长夹到时长');
  assert(clampRelative(1.5, 2) === 1.5, '区间内保持');
  assert(clampRelative(NaN, 2) === 0, 'NaN 按 0 处理');
  assert(clampRelative(1, NaN) === 0, '时长非法按 0 处理');
}

// 18. 单句跟读：MIME 选择与权限错误归类
{
  const supported = new Set(['audio/webm']);
  const isOk = (m: string) => supported.has(m);
  assert(pickRecorderMimeType(isOk) === 'audio/webm', 'webm 受支持时选中');
  assert(pickRecorderMimeType(() => false) === '', '全部不支持 -> 空串（用默认容器）');
  const safari = new Set(['audio/mp4']);
  assert(pickRecorderMimeType((m) => safari.has(m)) === 'audio/mp4', 'Safari 退回 mp4');
  // 抛异常的 isTypeSupported 不应击穿选择流程
  assert(
    pickRecorderMimeType((m) => {
      if (m === 'audio/webm') throw new Error('boom');
      return false;
    }) === '',
    'isTypeSupported 抛错时安全降级为空串'
  );

  const denied = describeGetUserMediaError(new DOMException('denied', 'NotAllowedError'));
  assert(denied.kind === 'permission' && denied.recoverable, '权限拒绝 -> 可恢复提示');
  const noDev = describeGetUserMediaError(new DOMException('x', 'NotFoundError'));
  assert(noDev.kind === 'device' && noDev.recoverable, '无设备 -> 可恢复提示');
  const unknown = describeGetUserMediaError(new Error('weird'));
  assert(unknown.kind === 'unknown' && unknown.text.includes('weird'), '未知错误保留原文案');
}

// 19. 区间漂移校准：锚点解析 / 线性映射 / 缩放 / 提交
{
  // 输入解析：纯秒、mm:ss、hh:mm:ss,ms、逗号 / 点分隔
  assert(parseDriftInput('12.5') === 12.5, '漂移输入纯秒 12.5');
  assert(parseDriftInput('1:02.5') === 62.5, '漂移输入 mm:ss.d');
  assert(parseDriftInput('00:01:02,500') === 62.5, '漂移输入 SRT 时间码（逗号）');
  assert(parseDriftInput('00:01:02.5') === 62.5, '漂移输入点毫秒');
  assert(parseDriftInput('1:62') === null, '秒位 >=60 拒绝');
  assert(parseDriftInput('') === null && parseDriftInput('abc') === null, '空 / 非法输入返回 null');
  assert(formatDriftInput(62.5) === '00:01:02,500', '漂移输入回显 SRT 格式');

  const dc = [
    { id: 'a', start: 0, end: 1, text: 'a' },
    { id: 'b', start: 2, end: 3, text: 'b' },
    { id: 'c', start: 4, end: 5, text: 'c' },
    { id: 'd', start: 6, end: 7, text: 'd' },
    { id: 'e', start: 8, end: 9, text: 'e' }
  ];
  const DR = { minDuration: 0.5, minGap: 0.08 };

  // Shift 选区解析（乱序传端点也可）
  const rng = resolveDriftRange(dc, 'd', 'b');
  assert(rng?.map((c) => c.id).join('') === 'bcd', '漂移区间 b..d（倒序端点）');
  assert(resolveDriftRange(dc, 'a', 'x') === null, '缺失端点 -> null');

  // 纯平移：原锚点 2 -> 3，末锚点 7 -> 8（+1s，等跨度），scale=1；与外邻 e(8) 恰间隔 0
  // 0.08 以下会被间隔拦截，故平移用 +1s 且外邻 e 起点为 8 -> 末条终点 8 会重叠；
  // 改为仅与外邻 a(prev,end1) 校验的平移方向：目标 0.08 起、5.08 止
  let plan = buildDriftPlan(
    [
      { id: 'a', start: 0, end: 1, text: 'a' },
      { id: 'b', start: 2, end: 4, text: 'b' },
      { id: 'c', start: 5, end: 7, text: 'c' }
    ],
    'b',
    'c',
    formatDriftInput(2.5),
    formatDriftInput(7.5),
    DR
  );
  assert(plan !== null && plan.conflict === null, '平移 0.5s 合法（等跨度）');
  assert(Math.abs(plan!.scale - 1) < 1e-9, '缩放比例 1x');
  assert(plan!.mapped[0].newStart === 2.5 && plan!.mapped[1].newEnd === 7.5, '锚点精确落到新时间');
  let applied = applyDriftPlan(
    [
      { id: 'a', start: 0, end: 1, text: 'a' },
      { id: 'b', start: 2, end: 4, text: 'b' },
      { id: 'c', start: 5, end: 7, text: 'c' }
    ],
    plan
  );
  assert(applied.find((c) => c.id === 'b')?.start === 2.5, '提交后 b 起点为 2.5');
  assert(applied.find((c) => c.id === 'a')?.start === 0, '区间外 a 不变');
  // 平移 +3.5s 后末条 end 10.5 与外邻 e(start8) 重叠 -> 拒绝
  plan = buildDriftPlan(dc, 'b', 'd', formatDriftInput(5.5), formatDriftInput(10.5), DR);
  assert(plan !== null && plan.conflict?.kind === 'gap-next', '平移与区间外下一条重叠被拒');

  // 缩放：3s 区间压到 1.5s，scale=0.5
  const sq = [
    { id: 'a', start: 0, end: 1, text: 'a' },
    { id: 'b', start: 2, end: 3, text: 'b' },
    { id: 'c', start: 4, end: 5, text: 'c' },
    { id: 'd', start: 10, end: 11, text: 'd' }
  ];
  plan = buildDriftPlan(sq, 'b', 'c', formatDriftInput(2), formatDriftInput(3.5), {
    minDuration: 0.5,
    minGap: 0.08
  });
  assert(plan !== null && plan.conflict === null, '缩放 0.5x 合法（区间内各块 0.5s 时长达标）');
  assert(Math.abs(plan!.scale - 0.5) < 1e-9, '缩放比例 0.5x');
  assert(plan!.mapped[0].newStart === 2 && plan!.mapped[0].newEnd === 2.5, 'b 映射为 2~2.5');
  assert(plan!.mapped[1].newStart === 3 && plan!.mapped[1].newEnd === 3.5, 'c 映射为 3~3.5');

  // 缩到 0.4x：块时长 0.4 < 0.5，首个冲突是第 1 条时长
  plan = buildDriftPlan(sq, 'b', 'c', formatDriftInput(2), formatDriftInput(3.2), DR);
  assert(plan?.conflict?.kind === 'duration', '缩放后时长不足 -> duration 冲突');
  assert(plan!.conflict?.cueId === 'b' && plan!.conflict.message.includes('第 1 条'), '首个冲突定位到区间第 1 条');

  // 目标锚点倒序（相等也算倒序）
  plan = buildDriftPlan(sq, 'b', 'c', formatDriftInput(5), formatDriftInput(5), DR);
  assert(plan?.conflict?.kind === 'target-order' && plan!.conflict.cueId === null, '目标锚点相等 -> 倒序冲突（无定位字幕）');
  plan = buildDriftPlan(sq, 'b', 'c', 'garbage', formatDriftInput(5), DR);
  assert(plan?.conflict?.kind === 'bad-input', '起点输入非法 -> bad-input');

  // 越过 0s 无法由合法输入构造：解析层拒绝负数，且 scale>0、targetStart>=0 时
  // 所有映射时间都 >= targetStart>=0 —— new-negative 被前置检查完全覆盖
  assert(parseDriftInput('-1') === null, '负时间输入在解析层即被拒绝');

  // 区间内间隔被压缩：b(2~3)/c(4~5) 压到 scale=0.4，新间隔 3.0-2.4=0.6 合法；
  // 再压 scale=0.3：b 2~2.3，c 2.6~2.9 间隔 0.3 合法；scale=0.2：间隔 0.2 合法；
  // 构造时长达标但间隔不足：块短、间隙大的序列
  const gapCues = [
    { id: 'a', start: 0, end: 0.6, text: 'a' },
    { id: 'b', start: 2, end: 2.6, text: 'b' }
  ];
  // 原区间 2.6s；映射到 1.3s（scale 0.5）：a 0~0.3 时长不足 -> duration 先报
  plan = buildDriftPlan(gapCues, 'a', 'b', '00:00:00,000', '00:00:01,300', {
    minDuration: 0.2,
    minGap: 0.08
  });
  // a: 0~0.3 时长 0.3；b: 1~1.3；间隔 0.7 合法
  assert(plan?.conflict === null, '短块 + 大间隔缩放到 1.3s 合法');
  // 映射到 0.8s（scale≈0.3077）：a end≈0.1846 时长不足 -> duration
  plan = buildDriftPlan(gapCues, 'a', 'b', '00:00:00,000', '00:00:00,800', {
    minDuration: 0.2,
    minGap: 0.08
  });
  assert(plan?.conflict?.kind === 'duration', '缩放后首条时长不足优先于间隔报错');

  // 构造「时长达标、间隔不足」：两条紧邻 0.08 间隙，放大间隔反而不会不足；
  // 缩小间隙：原 0~0.9 与 1.0~1.9（间隙 0.1），映射到 0~1.0（scale≈0.526）：
  // a 0~0.474 时长 0.474；b 0.526~1.0；间隔 0.052 < 0.08
  const gapCues2 = [
    { id: 'a', start: 0, end: 0.9, text: 'a' },
    { id: 'b', start: 1, end: 1.9, text: 'b' }
  ];
  plan = buildDriftPlan(gapCues2, 'a', 'b', '00:00:00,000', '00:00:01,000', {
    minDuration: 0.2,
    minGap: 0.08
  });
  assert(plan?.conflict?.kind === 'gap-next', '缩放后区间内间隔不足 -> gap-next');
  assert(plan!.conflict?.cueId === 'a' && plan!.conflict.time !== null, '间隔冲突定位到前一条并带时间');

  // 区间外上一条：首条直接映射到 0，但上一条结束在 0.5
  const outer = [
    { id: 'p', start: 0, end: 0.5, text: 'p' },
    { id: 'a', start: 2, end: 3, text: 'a' }
  ];
  plan = buildDriftPlan(outer, 'a', 'a', '00:00:00,200', '00:00:01,200', DR);
  assert(plan?.conflict?.kind === 'gap-prev', '与区间外上一条间隔不足 -> gap-prev');
  plan = buildDriftPlan(outer, 'a', 'a', '00:00:00,300', '00:00:01,300', DR);
  // 间隔 0.3-0.5 = -0.2 重叠
  assert(plan?.conflict?.kind === 'gap-prev' && plan!.conflict.message.includes('重叠'), '与区间外上一条重叠');
  plan = buildDriftPlan(outer, 'a', 'a', '00:00:00,580', '00:00:01,580', DR);
  assert(plan?.conflict === null, '与区间外上一条间隔恰好 0.08 合法');

  // 放大：scale>1，各时间线性外扩（11s 区间拉到 40s）
  plan = buildDriftPlan(
    [
      { id: 'a', start: 0, end: 1, text: 'a' },
      { id: 'b', start: 10, end: 11, text: 'b' }
    ],
    'a',
    'b',
    '00:00:00,000',
    '00:00:40,000',
    DR
  );
  assert(plan?.conflict === null && Math.abs(plan!.scale - 40 / 11) < 1e-9, '放大合法且比例为 40/11');
  assert(plan!.mapped[1].newStart === Math.round((40 / 11) * 10 * 1000) / 1000, '放大后内部锚点线性映射');

  // 单条区间：scale 恒为 1，等价于平移（无区间外邻居）
  plan = buildDriftPlan(
    [{ id: 'a', start: 1, end: 2, text: 'a' }],
    'a',
    'a',
    '00:00:05,000',
    '00:00:06,000',
    DR
  );
  assert(plan?.conflict === null && plan!.mapped[0].newStart === 5 && plan!.mapped[0].newEnd === 6, '单条区间平移 5~6');
  // 单条目标起止差值不等于原时长（倒序之外的任意值）：锚点严格映射，允许重定时长
  plan = buildDriftPlan(
    [{ id: 'a', start: 1, end: 2, text: 'a' }],
    'a',
    'a',
    '00:00:05,000',
    '00:00:05,600',
    DR
  );
  assert(plan?.conflict === null && Math.abs(plan!.scale - 0.6) < 1e-9, '单条区间可缩放（目标差值即新时长）');

  // 提交进入历史后可整体撤销重做
  {
    let h = initHistory(sq);
    const p = buildDriftPlan(sq, 'b', 'c', formatDriftInput(2), formatDriftInput(3.5), {
      minDuration: 0.5,
      minGap: 0.08
    })!;
    h = commitHistory(h, applyDriftPlan(sq, p));
    assert(h.past.length === 1, '漂移提交进入历史栈');
    h = undoHistory(h);
    assert(h.present.find((c) => c.id === 'b')?.start === 2, '撤销整体恢复漂移前时间');
    h = redoHistory(h);
    assert(h.present.find((c) => c.id === 'b')?.start === 2 && h.present.find((c) => c.id === 'b')?.end === 2.5, '重做再次应用漂移');
  }

  // 漂移结果随 SRT 导出（按新时间排序编号）
  {
    const p = buildDriftPlan(
      [
        { id: 'a', start: 0, end: 1, text: '一' },
        { id: 'b', start: 2, end: 3, text: '二' }
      ],
      'a',
      'b',
      '00:00:10,000',
      '00:00:13,000',
      DR
    )!;
    const out = serializeSrt(applyDriftPlan(
      [
        { id: 'a', start: 0, end: 1, text: '一' },
        { id: 'b', start: 2, end: 3, text: '二' }
      ],
      p
    ));
    assert(out.includes('00:00:10,000 --> 00:00:11,000') && out.includes('00:00:12,000 --> 00:00:13,000'), '漂移结果可由现有 SRT 导出');
  }
}

process.exit(fail ? 1 : 0);
