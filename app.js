"use strict";

/* =========================================================================
 * 多厅巡演排产台
 * 由「胶片分镜条核对台」扩展：卷 -> 巡演版本；片段带画幅/声轨/设备/
 * 授权时段/必放/优先级/同素材标识；排入影厅×日期场次，受时长、设备、
 * 授权、同素材互斥约束；锁定不可改动；拖拽与自动排程给出冲突原因、
 * 替代片段、影响范围；批量锁场、撤销重做、方案对比、冲突清单；
 * localStorage 持久化（含历史）；导入拦截异常数据。
 * ========================================================================= */

const STORAGE_KEY = "tour-schedule-desk-v1";
const HISTORY_LIMIT = 80;

const ASPECTS = ["1.37", "1.85", "2.39", "1.43"];
const AUDIOS = ["单声道", "立体声", "5.1环绕"];
const EQUIPMENT = ["胶片机", "数字机", "宽银幕镜头", "杜比处理器", "遮光幕", "字幕机"];
const EQUIP_COLOR = {
  胶片机: "#b54d48",
  数字机: "#347d89",
  宽银幕镜头: "#6d6378",
  杜比处理器: "#4d7656",
  遮光幕: "#d49b35",
  字幕机: "#8a6d3b"
};

const DATE_FMT = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" });

function uid(prefix = "id") {
  if (window.crypto?.randomUUID) return prefix + "-" + crypto.randomUUID().slice(0, 8);
  return prefix + "-" + Math.random().toString(36).slice(2, 10);
}
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}
function fmtTime(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  return h * 60 + m;
}
function fmtSec(seconds) {
  const v = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(v / 60)}′${String(v % 60).padStart(2, "0")}″`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : DATE_FMT.format(d);
}
function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/* 严格真实日历日期：必须是 YYYY-MM-DD 且月日真实存在（拒绝 2026-02-30、13 月等） */
function isValidCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(y, m, 0).getDate(); // 该月真实天数（Date 自动按闰年计算 2 月）
  return d <= dim;
}
/* 合法二十四小时时刻：HH:MM，时 00–23、分 00–59（拒绝 25:70） */
function isValidClockTime(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, mi] = value.split(":").map(Number);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}
/* 编号归一化：去全部空白、忽略大小写，用于同卷唯一性判定 */
function normalizeCode(code) {
  return String(code ?? "").replace(/\s+/g, "").toLowerCase();
}

/* ----------------------------- 默认数据 ----------------------------- */

function makeDefaultReels() {
  const halls = [
    { id: "h1", name: "一号厅", capacity: 220, aspect: "1.85", audio: "立体声", equipment: ["数字机", "宽银幕镜头", "字幕机"], turnMinutes: 20 },
    { id: "h2", name: "二号厅", capacity: 140, aspect: "2.39", audio: "5.1环绕", equipment: ["胶片机", "数字机", "宽银幕镜头", "杜比处理器"], turnMinutes: 25 },
    { id: "h3", name: "三号厅", capacity: 90, aspect: "1.37", audio: "单声道", equipment: ["胶片机", "遮光幕"], turnMinutes: 15 }
  ];
  const d0 = todayISO(0), d1 = todayISO(1), d2 = todayISO(2);
  const shows = [
    { id: "s11", hallId: "h1", date: d0, start: "14:00", end: "16:30" },
    { id: "s12", hallId: "h1", date: d0, start: "19:00", end: "21:30" },
    { id: "s13", hallId: "h1", date: d1, start: "14:00", end: "16:30" },
    { id: "s21", hallId: "h2", date: d0, start: "15:00", end: "17:30" },
    { id: "s22", hallId: "h2", date: d1, start: "19:30", end: "22:00" },
    { id: "s23", hallId: "h2", date: d2, start: "15:00", end: "17:30" },
    { id: "s31", hallId: "h3", date: d0, start: "13:30", end: "15:30" },
    { id: "s32", hallId: "h3", date: d2, start: "19:00", end: "21:00" }
  ];
  const seg = (o) => ({
    id: uid("seg"), sourceId: "", thumb: "", note: "", must: false, priority: 3,
    equipment: [], licenseStart: "", licenseEnd: "", ...o
  });
  const segments = [
    seg({ code: "T-101", title: "春日街景", duration: 900, aspect: "1.85", audio: "立体声", equipment: ["数字机"], priority: 1, must: true, sourceId: "M1", licenseStart: todayISO(-2), licenseEnd: todayISO(9), note: "开场，节奏平稳" }),
    seg({ code: "T-102", title: "夜港追光", duration: 1200, aspect: "2.39", audio: "5.1环绕", equipment: ["数字机", "杜比处理器"], priority: 1, must: true, sourceId: "M2", licenseStart: todayISO(-1), licenseEnd: todayISO(1) }),
    seg({ code: "T-103", title: "老城胶片版", duration: 780, aspect: "1.37", audio: "单声道", equipment: ["胶片机", "遮光幕"], priority: 2, must: false, sourceId: "M3", licenseStart: todayISO(-5), licenseEnd: todayISO(12) }),
    seg({ code: "T-104", title: "夜港追光（数字备份）", duration: 1200, aspect: "2.39", audio: "5.1环绕", equipment: ["数字机", "杜比处理器"], priority: 4, must: false, sourceId: "M2", licenseStart: todayISO(-1), licenseEnd: todayISO(12), note: "与 T-102 同一素材，互斥" }),
    seg({ code: "T-105", title: "河畔假日", duration: 600, aspect: "1.85", audio: "立体声", equipment: ["数字机", "字幕机"], priority: 2, must: false, sourceId: "M4", licenseStart: todayISO(0), licenseEnd: todayISO(20) }),
    seg({ code: "T-106", title: "默片拾遗", duration: 1500, aspect: "1.37", audio: "单声道", equipment: ["胶片机"], priority: 5, must: false, sourceId: "M5", licenseStart: "", licenseEnd: "" }),
    seg({ code: "T-107", title: "宽幕庆典", duration: 1080, aspect: "2.39", audio: "5.1环绕", equipment: ["数字机", "宽银幕镜头"], priority: 3, must: false, sourceId: "M6", licenseStart: todayISO(1), licenseEnd: todayISO(30), note: "授权明天才开始" }),
    seg({ code: "T-108", title: "春日街景（复刻）", duration: 900, aspect: "1.85", audio: "立体声", equipment: ["数字机"], priority: 4, must: false, sourceId: "M1", licenseStart: todayISO(-2), licenseEnd: todayJSONEndSafe(9) }),
    // 无解演示：2.39 宽幕 + 杜比 + 胶片机，没有任何影厅同时满足（二号厅有杜比但无遮光需求，这里设备组合无解）
    seg({ code: "T-109", title: "胶卷宽幕孤本", duration: 1740, aspect: "2.39", audio: "单声道", equipment: ["胶片机", "杜比处理器", "宽银幕镜头"], priority: 1, must: true, sourceId: "M7", licenseStart: todayISO(0), licenseEnd: todayISO(30), note: "需胶片机+杜比+宽幕，无厅满足，自动排程应判无解" })
  ];
  // 预先锁定一个合法安排：T-102 固定在二号厅次日 19:30（s22，画幅/声轨/设备/授权均满足）
  const t102 = segments.find((s) => s.code === "T-102");
  const basePlaced = [{ id: uid("pl"), showId: "s22", segmentId: t102.id, locked: true }];
  return [{
    id: uid("reel"),
    name: "华东巡演 · 母卷",
    tour: true,
    copiedFrom: "",
    halls,
    shows,
    segments,
    placed: basePlaced
  }];
}
function todayJSONEndSafe(offset) { return todayISO(offset); }

function defaultState() {
  const reels = makeDefaultReels();
  const plan0 = {
    id: uid("plan"),
    name: "主方案",
    reelId: reels[0].id,
    placed: clone(reels[0].placed),
    createdAt: Date.now()
  };
  return {
    version: 1,
    currentReelId: reels[0].id,
    currentPlanId: plan0.id,
    reels,
    plans: [plan0]
  };
}

/* --------------------------- 持久化 + 历史 --------------------------- */

let state = null;
let history = { past: [], future: [] };
let batchMode = false;
// 上一个检查点的状态：commit 在“变更后”调用，故压入的撤销目标应是变更前的检查点
let checkpoint = null;

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  let parsed;
  try {
    const wrapped = JSON.parse(raw);
    // 持久化结构为 { state, past, future }；兼容早期裸 state
    parsed = wrapped && typeof wrapped === "object" && wrapped.state ? wrapped.state : wrapped;
  } catch {
    return defaultState();
  }
  const base = defaultState();
  // 结构性兜底：异常数据不能进入页面
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.reels) || !parsed.reels.length) {
    return base;
  }
  const okReels = parsed.reels.filter((r) => r && Array.isArray(r.segments) && Array.isArray(r.shows) && Array.isArray(r.halls));
  if (!okReels.length) return base;
  parsed.reels = okReels;
  if (!parsed.reels.some((r) => r.id === parsed.currentReelId)) parsed.currentReelId = parsed.reels[0].id;
  if (!Array.isArray(parsed.plans) || !parsed.plans.length) {
    parsed.plans = base.plans;
    parsed.plans[0].reelId = parsed.currentReelId;
  }
  if (!parsed.plans.some((p) => p.id === parsed.currentPlanId)) parsed.currentPlanId = parsed.plans[0].id;
  return parsed;
}
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, past: history.past, future: history.future, checkpoint }));
  } catch (e) {
    toast("保存失败：本地存储空间不足", "error");
  }
}
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.past) && Array.isArray(parsed.future)) {
      history.past = parsed.past.slice(-HISTORY_LIMIT);
      history.future = parsed.future.slice(-HISTORY_LIMIT);
    }
    // 检查点 = 最近一次提交后的状态；首次运行时即为当前初始状态
    checkpoint = parsed.checkpoint ? parsed.checkpoint : clone(state);
  } catch { /* 忽略历史损坏 */ }
}

/* 历史语义：past 存“操作发生前”的检查点；checkpoint 始终是最近一次提交时的状态。
   commit 在“变更完成后”调用，因此压入的是变更前的 checkpoint，再把 checkpoint 更新为现状。 */
function commit(label) {
  if (checkpoint) history.past.push({ label, state: clone(checkpoint) });
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future = [];
  checkpoint = clone(state);
  persist();
  render();
}
function undo() {
  if (!history.past.length) { toast("没有可撤销的操作"); return; }
  const prev = history.past.pop();
  history.future.push({ label: prev.label, state: clone(state) }); // 当前状态供重做
  state = prev.state;
  checkpoint = clone(state);
  persist();
  render();
  toast(`已撤销：${prev.label}`);
}
function redo() {
  if (!history.future.length) { toast("没有可重做的操作"); return; }
  const next = history.future.pop();
  history.past.push({ label: next.label, state: clone(state) });
  state = next.state;
  checkpoint = clone(state);
  persist();
  render();
  toast(`已重做：${next.label}`);
}

/* ----------------------------- 选择器 ----------------------------- */

function currentReel() {
  return state.reels.find((r) => r.id === state.currentReelId) || state.reels[0];
}
function currentPlan() {
  return state.plans.find((p) => p.id === state.currentPlanId && p.reelId === state.currentReelId)
    || state.plans.find((p) => p.reelId === state.currentReelId)
    || null;
}
function segById(reel, id) { return reel.segments.find((s) => s.id === id); }
function showById(reel, id) { return reel.shows.find((s) => s.id === id); }
function hallById(reel, id) { return reel.halls.find((h) => h.id === id); }

/* 有效排片：当前方案中属于本卷且场次仍存在的条目 */
function effectivePlaced(reel, plan) {
  if (!plan) return [];
  const showIds = new Set(reel.shows.map((s) => s.id));
  return plan.placed.filter((p) => showIds.has(p.showId));
}

/* ------------------------- 约束检查 / 冲突引擎 ------------------------- */

/**
 * 计算把 segment 放入 show 的全部冲突原因；忽略 exceptPlacedId 自身。
 * 返回 reason 数组（空数组 = 可行）。
 */
function placementViolations(reel, plan, segment, show, exceptPlacedId = null) {
  const reasons = [];
  if (!segment || !show) return ["片段或场次不存在"];
  const hall = hallById(reel, show.hallId);
  if (!hall) return ["影厅不存在"];

  // 1. 时长：场次容量 - 同场次其他片段（含清场）
  const others = effectivePlaced(reel, plan).filter(
    (p) => p.showId === show.id && p.id !== exceptPlacedId && p.segmentId
  );
  const turn = (hall.turnMinutes || 0) * Math.max(0, others.length); // 简化：每场首片不额外计清场
  const used = others.reduce((sum, p) => {
    const s = segById(reel, p.segmentId);
    return sum + (s ? Number(s.duration) : 0);
  }, 0) + turn;
  const cap = (hmToMinutes(show.end) - hmToMinutes(show.start)) * 60;
  if (Number(segment.duration) + used > cap) {
    reasons.push(`时长超限：本场剩余 ${fmtSec(Math.max(0, cap - used))}，片段需 ${fmtSec(segment.duration)}`);
  }

  // 2. 画幅
  if (segment.aspect && hall.aspect && segment.aspect !== hall.aspect) {
    reasons.push(`画幅不匹配：片段 ${segment.aspect}，${hall.name} 仅支持 ${hall.aspect}`);
  }

  // 3. 声轨
  if (segment.audio && hall.audio && segment.audio !== hall.audio) {
    reasons.push(`声轨不兼容：片段 ${segment.audio}，${hall.name} 为 ${hall.audio}`);
  }

  // 4. 设备
  const missing = (segment.equipment || []).filter((e) => !(hall.equipment || []).includes(e));
  if (missing.length) reasons.push(`设备不足：${hall.name}缺少 ${missing.join("、")}`);

  // 5. 授权时段
  if (segment.licenseStart && show.date < segment.licenseStart) {
    reasons.push(`授权未开始：${segment.licenseStart} 起，本场为 ${show.date}`);
  }
  if (segment.licenseEnd && show.date > segment.licenseEnd) {
    reasons.push(`授权已过期：至 ${segment.licenseEnd}，本场为 ${show.date}`);
  }

  // 6. 同素材互斥：同一天任意影厅不得重复同一 sourceId
  if (segment.sourceId) {
    const clash = effectivePlaced(reel, plan).find((p) => {
      if (p.id === exceptPlacedId || !p.segmentId) return false;
      const sh = showById(reel, p.showId);
      const s = segById(reel, p.segmentId);
      return sh && sh.date === show.date && s && s.sourceId === segment.sourceId && s.id !== segment.id;
    });
    if (clash) {
      const cs = segById(reel, clash.segmentId);
      const csh = showById(reel, clash.showId);
      const ch = hallById(reel, csh.hallId);
      reasons.push(`同素材互斥：${fmtDate(show.date)} 已在${ch.name}安排同素材「${cs.code} ${cs.title || ""}」`);
    }
  }
  return reasons;
}

/** 找替代片段：可放入该场次、非互斥素材，按优先级/时长利用率排序 */
function findAlternatives(reel, plan, show, excludeSegmentId = null, limit = 5) {
  const usedIds = new Set(effectivePlaced(reel, plan).filter((p) => p.segmentId).map((p) => p.segmentId));
  const cap = (hmToMinutes(show.end) - hmToMinutes(show.start)) * 60;
  const alts = [];
  for (const s of reel.segments) {
    if (s.id === excludeSegmentId) continue;
    if (usedIds.has(s.id)) continue;
    const v = placementViolations(reel, plan, s, show);
    if (v.length === 0) {
      alts.push({ segment: s, score: Number(s.priority) * 1000 + Math.abs(cap - Number(s.duration)) / 60 });
    }
  }
  alts.sort((a, b) => a.score - b.score);
  return alts.slice(0, limit).map((a) => a.segment);
}

/** 一次操作的影响范围：列出被波及的已排片段 */
function impactOf(reel, plan, segment, show, exceptPlacedId = null) {
  const impacts = [];
  // 同场次因清场/容量被影响
  effectivePlaced(reel, plan).forEach((p) => {
    if (p.id === exceptPlacedId || !p.segmentId) return;
    const sh = showById(reel, p.showId);
    const s = segById(reel, p.segmentId);
    if (!sh || !s) return;
    if (p.showId === show.id) impacts.push(`${s.code}（同场容量）`);
    else if (segment.sourceId && sh.date === show.date && s.sourceId === segment.sourceId) {
      impacts.push(`${s.code}（同素材 ${fmtDate(show.date)}）`);
    }
  });
  return [...new Set(impacts)];
}

/** 全量冲突清单（针对当前方案） */
function computeConflicts(reel, plan) {
  const conflicts = [];
  for (const p of effectivePlaced(reel, plan)) {
    if (!p.segmentId) continue;
    const seg = segById(reel, p.segmentId);
    const show = showById(reel, p.showId);
    if (!seg || !show) continue;
    const reasons = placementViolations(reel, plan, seg, show, p.id);
    if (reasons.length) {
      conflicts.push({ placedId: p.id, segment: seg, show, hall: hallById(reel, show.hallId), reasons, locked: !!p.locked });
    }
  }
  // 必放未排
  const placedSegIds = new Set(effectivePlaced(reel, plan).map((p) => p.segmentId).filter(Boolean));
  for (const s of reel.segments) {
    if (s.must && !placedSegIds.has(s.id)) {
      conflicts.push({ placedId: null, segment: s, show: null, hall: null, reasons: ["必放片段尚未排入任何场次"], locked: false, missing: true });
    }
  }
  return conflicts;
}

/* ----------------------------- 自动排程 ----------------------------- */

/**
 * 回溯式自动排程。
 * 选项：{ keepLocked: 保留锁定, mustOnly: 仅必放 }
 * 返回 { placed: [...完整 placed], report: {scheduled,failed,alternatives} }
 * 不直接修改 state。
 */
function autoSchedule(reel, currentPlan, opts = {}) {
  const keepLocked = opts.keepLocked !== false;
  const mustOnly = !!opts.mustOnly;

  // 以现有 placed 为基础：保留锁定（或全部已有，当 keepLocked 全保留时）
  const base = [];
  const occupied = {}; // showId -> 已用秒（含清场）
  const sourceDay = new Set(); // `${sourceId}|${date}`
  const fixedSeg = new Set();

  for (const p of effectivePlaced(reel, currentPlan)) {
    const np = { ...p };
    if (p.locked && keepLocked && p.segmentId) {
      base.push(np);
      fixedSeg.add(p.segmentId);
      const sh = showById(reel, p.showId);
      const sg = segById(reel, p.segmentId);
      if (sh && sg) {
        const hall = hallById(reel, sh.hallId);
        occupied[sh.id] = (occupied[sh.id] || 0) + Number(sg.duration);
        if (sg.sourceId) sourceDay.add(sg.sourceId + "|" + sh.date);
      }
    } else if (keepLocked && p.segmentId) {
      // 已有的非锁定安排也作为可被替换的空位：先清空，仅保留空槽位结构
      base.push({ ...np, segmentId: null, locked: false });
    } else {
      base.push({ ...np, segmentId: null, locked: false });
    }
  }
  // 确保每个场次都有槽位
  const showSlotIds = new Set(base.map((b) => b.showId));
  for (const sh of reel.shows) {
    if (!showSlotIds.has(sh.id)) base.push({ id: uid("pl"), showId: sh.id, segmentId: null, locked: false });
  }

  // 待排片段：必放优先，再按优先级、时长降序
  let candidates = reel.segments.filter((s) => !fixedSeg.has(s.id));
  if (mustOnly) candidates = candidates.filter((s) => s.must);
  candidates = [...candidates].sort((a, b) =>
    (Number(b.must) - Number(a.must)) ||
    (Number(a.priority) - Number(b.priority)) ||
    (Number(b.duration) - Number(a.duration)));

  const shows = reel.shows;
  const slotByShow = {};
  base.forEach((p) => { (slotByShow[p.showId] = slotByShow[p.showId] || []).push(p); });

  const scheduled = [];
  const failed = [];

  function fits(seg, show) {
    // 快速检查（基于动态占用）
    const hall = hallById(reel, show.hallId);
    if (!hall) return false;
    if (seg.aspect && hall.aspect && seg.aspect !== hall.aspect) return false;
    if (seg.audio && hall.audio && seg.audio !== hall.audio) return false;
    if ((seg.equipment || []).some((e) => !(hall.equipment || []).includes(e))) return false;
    if (seg.licenseStart && show.date < seg.licenseStart) return false;
    if (seg.licenseEnd && show.date > seg.licenseEnd) return false;
    if (seg.sourceId && sourceDay.has(seg.sourceId + "|" + show.date)) return false;
    const slots = slotByShow[show.id] || [];
    const filled = slots.filter((p) => p.segmentId).length;
    const used = occupied[show.id] || 0;
    const turn = hall.turnMinutes * filled;
    const cap = (hmToMinutes(show.end) - hmToMinutes(show.start)) * 60;
    if (Number(seg.duration) + used + turn > cap) return false;
    return true;
  }
  function put(seg, show) {
    if (!slotByShow[show.id]) slotByShow[show.id] = [];
    let slot = slotByShow[show.id].find((p) => !p.segmentId);
    if (!slot) { slot = { id: uid("pl"), showId: show.id, segmentId: null, locked: false }; slotByShow[show.id].push(slot); base.push(slot); }
    slot.segmentId = seg.id;
    occupied[show.id] = (occupied[show.id] || 0) + Number(seg.duration);
    if (seg.sourceId) sourceDay.add(seg.sourceId + "|" + show.date);
  }
  function unput(seg, show) {
    const slot = slotByShow[show.id].find((p) => p.segmentId === seg.id);
    if (slot) slot.segmentId = null;
    occupied[show.id] = (occupied[show.id] || 0) - Number(seg.duration);
    if (seg.sourceId) sourceDay.delete(seg.sourceId + "|" + show.date);
  }

  // 为每个片段按"适配度"排序场次：必放优先选容量贴合、日期早
  function showOptions(seg) {
    return shows.filter((sh) => fits(seg, sh)).sort((a, b) => {
      const ca = (hmToMinutes(a.end) - hmToMinutes(a.start)) * 60;
      const cb = (hmToMinutes(b.end) - hmToMinutes(b.start)) * 60;
      return Math.abs(ca - Number(seg.duration)) - Math.abs(cb - Number(seg.duration)) ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    });
  }

  function backtrack(i) {
    if (i === candidates.length) return true;
    const seg = candidates[i];
    const options = showOptions(seg);
    for (const show of options) {
      put(seg, show);
      scheduled[i] = { seg, show };
      if (backtrack(i + 1)) return true;
      unput(seg, show);
    }
    return false;
  }

  // 先尽量满足必放（硬目标），再填其余；整体回溯一次即可，因为必放已排在候选最前。
  // 但为了在"无解"时仍最大化，采用：完整回溯，找不到全体解则逐段降级。
  const ok = backtrack(0);
  if (!ok) {
    // 贪心兜底：逐个放置，记录无法放置者及替代
    for (const seg of candidates) {
      const already = scheduledVia(slotByShow, seg);
      if (already) continue;
      const opt = showOptions(seg)[0];
      if (opt) put(seg, opt);
      else failed.push(seg);
    }
  }
  // 收集失败/未排片段
  const placedSegIds = new Set();
  base.forEach((p) => p.segmentId && placedSegIds.add(p.segmentId));
  for (const seg of candidates) {
    if (!placedSegIds.has(seg.id) && !failed.includes(seg)) failed.push(seg);
  }

  const alternatives = {};
  for (const seg of failed) {
    alternatives[seg.id] = suggestForSegment(reel, { shows, fitsExternal: (s, sh) => {
      // 用静态检查给"任意可行场次"
      const hall = hallById(reel, sh.hallId);
      if (!hall) return false;
      if (s.aspect && hall.aspect && s.aspect !== hall.aspect) return false;
      if (s.audio && hall.audio && s.audio !== hall.audio) return false;
      if ((s.equipment || []).some((e) => !(hall.equipment || []).includes(e))) return false;
      if (s.licenseStart && sh.date < s.licenseStart) return false;
      if (s.licenseEnd && sh.date > s.licenseEnd) return false;
      const cap = (hmToMinutes(sh.end) - hmToMinutes(sh.start)) * 60;
      return Number(s.duration) <= cap;
    } }, seg);
  }

  return {
    placed: base,
    report: {
      scheduledCount: placedSegIds.size - fixedSeg.size,
      lockedCount: fixedSeg.size,
      failed,
      alternatives
    }
  };
}
function scheduledVia(slotByShow, seg) {
  return Object.values(slotByShow).some((slots) => slots.some((p) => p.segmentId === seg.id));
}
/** 为失败片段找：可行场次列表 + 各场次替代片名 */
function suggestForSegment(reel, ctx, seg) {
  const viableShows = [];
  for (const sh of reel.shows) {
    const blockers = [];
    const hall = hallById(reel, sh.hallId);
    if (seg.aspect && hall.aspect && seg.aspect !== hall.aspect) blockers.push(`画幅 ${seg.aspect}≠${hall.aspect}`);
    if (seg.audio && hall.audio && seg.audio !== hall.audio) blockers.push(`声轨`);
    const miss = (seg.equipment || []).filter((e) => !(hall.equipment || []).includes(e));
    if (miss.length) blockers.push(`缺设备 ${miss.join("/")}`);
    if (seg.licenseStart && sh.date < seg.licenseStart) blockers.push("授权未开始");
    if (seg.licenseEnd && sh.date > seg.licenseEnd) blockers.push("授权已过期");
    const cap = (hmToMinutes(sh.end) - hmToMinutes(sh.start)) * 60;
    if (Number(seg.duration) > cap) blockers.push("场次时长不足");
    if (!blockers.length) viableShows.push(`${hall.name} ${fmtDate(sh.date)} ${sh.start}`);
  }
  return { viableShows };
}

/* ----------------------------- 排片操作 ----------------------------- */

function ensureSlots(reel, plan) {
  const have = new Set(plan.placed.map((p) => p.showId));
  reel.shows.forEach((sh) => {
    if (!have.has(sh.id)) plan.placed.push({ id: uid("pl"), showId: sh.id, segmentId: null, locked: false });
  });
}

function placeSegment(segmentId, showId) {
  const reel = currentReel();
  const plan = currentPlan();
  if (!plan) { toast("请先选择或创建方案"); return; }
  const seg = segById(reel, segmentId);
  const show = showById(reel, showId);
  if (!seg || !show) return;
  ensureSlots(reel, plan);

  // 若该片段在别的场次，移动它（除非源槽位锁定）
  const existing = plan.placed.find((p) => p.segmentId === segmentId);
  if (existing && existing.locked) {
    showConflictModal(reel, plan, seg, show, null, ["该片段处于锁定场次，无法移动"]);
    return;
  }
  // 目标场次若已有槽位锁定冲突：锁定槽位不能被覆盖，但可同场加排
  const reasons = placementViolations(reel, plan, seg, show, existing ? existing.id : null);
  const impacts = impactOf(reel, plan, seg, show, existing ? existing.id : null);

  if (reasons.length) {
    const alts = findAlternatives(reel, plan, show, segmentId);
    showConflictModal(reel, plan, seg, show, alts, reasons, impacts, { allowForce: false });
    return;
  }

  if (existing) {
    existing.showId = showId; // 移动
  } else {
    let slot = plan.placed.find((p) => p.showId === showId && !p.segmentId && !p.locked);
    if (!slot) {
      // 同场追加新槽位（容量已由约束保证）
      slot = { id: uid("pl"), showId, segmentId: null, locked: false };
      plan.placed.push(slot);
    }
    slot.segmentId = segmentId;
  }
  commit(existing ? `移动 ${seg.code} 到 ${hallById(reel, show.hallId).name}` : `排映 ${seg.code}`);
  if (impacts.length) toast(`已排映，影响：${impacts.join("、")}`, "info");
}

function removeFromSlot(placedId) {
  const reel = currentReel();
  const plan = currentPlan();
  const p = plan.placed.find((x) => x.id === placedId);
  if (!p) return;
  if (p.locked) { toast("该安排已锁定，不能移除", "error"); return; }
  const seg = p.segmentId ? segById(reel, p.segmentId) : null;
  p.segmentId = null;
  commit(`撤下 ${seg ? seg.code : "片段"}`);
}

function toggleSlotLock(placedId, forceLock) {
  const plan = currentPlan();
  const p = plan.placed.find((x) => x.id === placedId);
  if (!p || !p.segmentId) { toast("空场次不能锁定"); return; }
  p.locked = typeof forceLock === "boolean" ? forceLock : !p.locked;
  commit(p.locked ? "锁定场次" : "解锁场次");
}

/* ----------------------------- DOM ----------------------------- */

const $ = (sel) => document.querySelector(sel);
const els = {};
function cacheEls() {
  [
    "reelSelect", "copyTourBtn", "newTourBtn", "undoBtn", "redoBtn", "autoBtn", "batchLockBtn",
    "compareBtn", "importBtn", "exportBtn", "importFile", "batchBar", "batchAll", "batchApplyLock",
    "batchApplyUnlock", "batchExit", "toggleFormBtn", "segmentForm", "editId", "codeInput",
    "titleInput", "durationInput", "aspectInput", "audioInput", "priorityInput", "equipmentInput",
    "sourceInput", "licenseStartInput", "licenseEndInput", "mustInput", "thumbInput", "noteInput",
    "formSubmitBtn", "formCancelBtn", "searchInput", "mustOnlyFilter", "segmentList",
    "scheduleGrid", "gridHint", "planSelect", "savePlanBtn", "planMeta", "conflictList", "recheckBtn",
    "modalOverlay", "modalTitle", "modalBody", "modalCloseBtn", "toast",
    "statPlaced", "statMust", "statConflicts", "statLocked"
  ].forEach((id) => { els[id] = document.getElementById(id); });
}

let pendingThumb = "";

/* ----------------------------- 渲染 ----------------------------- */

function renderEquipmentChecks() {
  els.equipmentInput.innerHTML = EQUIPMENT.map((e) =>
    `<label class="inline-check"><input type="checkbox" value="${esc(e)}" data-equip /> ${esc(e)}</label>`
  ).join("");
}

function renderReelSelect() {
  const cur = state.currentReelId;
  els.reelSelect.innerHTML = state.reels.map((r) =>
    `<option value="${esc(r.id)}" ${r.id === cur ? "selected" : ""}>${esc(r.name)}${r.tour ? " 🎬" : ""}</option>`
  ).join("");
}

function renderPlanSelect() {
  const reel = currentReel();
  const mine = state.plans.filter((p) => p.reelId === reel.id);
  if (!mine.some((p) => p.id === state.currentPlanId)) {
    state.currentPlanId = mine[0]?.id;
  }
  els.planSelect.innerHTML = mine.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === state.currentPlanId ? "selected" : ""}>${esc(p.name)}</option>`
  ).join("") || `<option value="">（无方案）</option>`;
  renderPlanMeta();
}

function renderPlanMeta() {
  const reel = currentReel();
  const plan = currentPlan();
  if (!plan) { els.planMeta.textContent = ""; return; }
  const placed = effectivePlaced(reel, plan).filter((p) => p.segmentId);
  const mins = placed.reduce((sum, p) => sum + Number(segById(reel, p.segmentId)?.duration || 0) / 60, 0);
  els.planMeta.innerHTML =
    `<div class="meta-line"><span>方案</span><strong>${esc(plan.name)}</strong></div>` +
    `<div class="meta-line"><span>已排 / 锁定</span><strong>${placed.length} 段 · ${placed.filter((p) => p.locked).length} 锁</strong></div>` +
    `<div class="meta-line"><span>总片长</span><strong>${Math.round(mins)} 分钟</strong></div>`;
}

function renderLibrary() {
  const reel = currentReel();
  const plan = currentPlan();
  const kw = els.searchInput.value.trim().toLowerCase();
  const mustOnly = els.mustOnlyFilter.checked;
  const placedIds = new Set(effectivePlaced(reel, plan).map((p) => p.segmentId).filter(Boolean));
  const list = reel.segments
    .filter((s) => !mustOnly || s.must)
    .filter((s) => !kw || `${s.code} ${s.title} ${s.note}`.toLowerCase().includes(kw))
    .sort((a, b) => Number(a.priority) - Number(b.priority) || a.code.localeCompare(b.code));

  els.segmentList.innerHTML = list.map((s) => {
    const placed = placedIds.has(s.id);
    const equip = (s.equipment || []).map((e) =>
      `<span class="chip" style="--c:${EQUIP_COLOR[e] || "#666"}">${esc(e)}</span>`).join("");
    return `
    <article class="lib-card ${placed ? "placed" : ""}" draggable="true" data-seg="${esc(s.id)}" title="拖拽到右侧场次">
      <div class="lib-head">
        <strong>${esc(s.code)}</strong>
        <span class="prio p${s.priority}">P${esc(s.priority)}</span>
        ${s.must ? `<span class="must-tag">必放</span>` : ""}
        ${placed ? `<span class="placed-tag">已排</span>` : ""}
      </div>
      <div class="lib-title">${esc(s.title || "（未命名）")} · ${fmtSec(s.duration)}</div>
      <div class="lib-tags">
        <span class="chip neutral">${esc(s.aspect)}</span>
        <span class="chip neutral">${esc(s.audio)}</span>${equip}
        ${s.sourceId ? `<span class="chip src">同素材 ${esc(s.sourceId)}</span>` : ""}
      </div>
      <div class="lib-license">授权 ${s.licenseStart ? esc(s.licenseStart) : "—"} ~ ${s.licenseEnd ? esc(s.licenseEnd) : "—"}</div>
      <div class="lib-actions">
        <button type="button" class="mini" data-edit="${esc(s.id)}">编辑</button>
        <button type="button" class="mini" data-del="${esc(s.id)}">删除</button>
      </div>
    </article>`;
  }).join("") || `<p class="empty">素材库为空。</p>`;
}

function renderGrid() {
  const reel = currentReel();
  const plan = currentPlan();
  const placedList = effectivePlaced(reel, plan);
  const slotByShow = {};
  placedList.forEach((p) => (slotByShow[p.showId] = slotByShow[p.showId] || []).push(p));
  // 冲突索引
  const conflictByPlaced = new Map();
  computeConflicts(reel, plan).forEach((c) => { if (c.placedId) conflictByPlaced.set(c.placedId, c.reasons); });

  const dates = [...new Set(reel.shows.map((s) => s.date))].sort();
  const head = `<div class="grid-corner">影厅 ＼ 日期</div>` +
    dates.map((d) => `<div class="grid-date">${fmtDate(d)}<small>${esc(d)}</small></div>`).join("");

  const rows = reel.halls.map((hall) => {
    const hallInfo = `<div class="hall-info">
        <strong>${esc(hall.name)}</strong>
        <small>${esc(hall.aspect)} · ${esc(hall.audio)}</small>
        <small class="equip">${(hall.equipment || []).map(esc).join(" / ") || "无设备"}</small>
      </div>`;
    const cells = dates.map((date) => {
      const dayShows = reel.shows.filter((s) => s.hallId === hall.id && s.date === date)
        .sort((a, b) => a.start.localeCompare(b.start));
      if (!dayShows.length) return `<div class="grid-cell no-show"><span>无场次</span></div>`;
      const showHtml = dayShows.map((show) => {
        const slots = slotByShow[show.id] || [];
        const cap = (hmToMinutes(show.end) - hmToMinutes(show.start)) * 60;
        const used = slots.reduce((sum, p) => sum + (p.segmentId ? Number(segById(reel, p.segmentId)?.duration || 0) : 0), 0);
        const cards = slots.map((p) => {
          if (!p.segmentId) return "";
          const s = segById(reel, p.segmentId);
          if (!s) return "";
          const reasons = conflictByPlaced.get(p.id);
          return `<div class="slot-card ${p.locked ? "locked" : ""} ${reasons ? "conflict" : ""}" data-placed="${esc(p.id)}" draggable="true" title="${reasons ? esc(reasons.join("；")) : "拖拽可移动，点 × 撤下"}">
              <span class="slot-code">${esc(s.code)}</span>
              ${s.must ? `<i class="mini-must">必</i>` : ""}
              ${p.locked ? `<i class="mini-lock">🔒</i>` : ""}
              ${reasons ? `<i class="mini-err">!</i>` : ""}
              ${!p.locked ? `<button class="slot-x" data-remove="${esc(p.id)}" title="撤下">×</button>` : ""}
            </div>`;
        }).join("");
        const over = used > cap;
        return `<div class="show-block ${slots.some((p) => conflictByPlaced.has(p.id)) ? "has-conflict" : ""}" data-show="${esc(show.id)}">
            <div class="show-time">${esc(show.start)}–${esc(show.end)}
              <label class="slot-check" ${batchMode ? "" : "hidden"}><input type="checkbox" data-batch-slot="${esc(show.id)}" /></label>
            </div>
            <div class="show-cap ${over ? "over" : ""}">${fmtSec(used)} / ${fmtSec(cap)}</div>
            <div class="slot-drop" data-show="${esc(show.id)}">${cards || `<span class="drop-hint">拖入片段</span>`}</div>
          </div>`;
      }).join("");
      return `<div class="grid-cell">${showHtml}</div>`;
    }).join("");
    return hallInfo + cells;
  }).join("");

  els.scheduleGrid.style.setProperty("--cols", dates.length + 1);
  els.scheduleGrid.innerHTML = head + rows;
}

function renderConflicts() {
  const reel = currentReel();
  const plan = currentPlan();
  const conflicts = computeConflicts(reel, plan);
  els.conflictList.innerHTML = conflicts.map((c, i) => {
    const where = c.show ? `${esc(c.hall.name)} · ${fmtDate(c.show.date)} ${esc(c.show.start)}` : "未安排";
    return `<div class="conflict-item ${c.missing ? "missing" : ""} ${c.locked ? "is-locked" : ""}">
      <div class="conflict-head"><strong>${i + 1}. ${esc(c.segment.code)}</strong>
        ${c.locked ? `<span class="lockflag">锁定冲突</span>` : ""}</div>
      <div class="conflict-where">${esc(c.segment.title || "")} · ${where}</div>
      <ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    </div>`;
  }).join("") || `<p class="empty">✅ 当前方案没有冲突，必放片段均已排入。</p>`;

  const placed = effectivePlaced(reel, plan).filter((p) => p.segmentId);
  els.statPlaced.textContent = placed.length;
  els.statMust.textContent = reel.segments.filter((s) => s.must && !placed.some((p) => p.segmentId === s.id)).length;
  els.statConflicts.textContent = conflicts.length;
  els.statLocked.textContent = placed.filter((p) => p.locked).length;
}

function render() {
  renderReelSelect();
  renderPlanSelect();
  renderLibrary();
  renderGrid();
  renderConflicts();
  els.undoBtn.disabled = !history.past.length;
  els.redoBtn.disabled = !history.future.length;
  els.batchBar.hidden = !batchMode;
  els.batchLockBtn.textContent = batchMode ? "退出批量" : "批量锁场";
}

/* ----------------------------- 弹窗 / Toast ----------------------------- */

let modalCloseHandler = null;
function openModal(title, bodyHtml) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = bodyHtml;
  els.modalOverlay.hidden = false;
}
function closeModal() { els.modalOverlay.hidden = true; }

function showConflictModal(reel, plan, seg, show, alternatives, reasons, impacts = [], opts = {}) {
  const hall = hallById(reel, show.hallId);
  const altsHtml = (alternatives || []).length
    ? `<div class="alt-section"><h4>可替代片段（点击直接排入本场）</h4><div class="alt-list">` +
      alternatives.map((a) => `<button class="alt-card" data-alt-place="${esc(a.id)}" data-alt-show="${esc(show.id)}">
          <strong>${esc(a.code)}</strong><span>${esc(a.title || "")} · ${fmtSec(a.duration)} · P${esc(a.priority)}</span>
          <small>${esc(a.aspect)} / ${esc(a.audio)}</small></button>`).join("") + `</div></div>`
    : `<p class="empty">本场没有满足全部约束的空闲替代片段。</p>`;
  const impactHtml = impacts.length
    ? `<div class="impact-section"><h4>影响范围</h4><p>${impacts.map(esc).join("；")}</p></div>` : "";
  openModal("无法排映：存在冲突", `
    <div class="conflict-summary">
      <p><strong>${esc(seg.code)} ${esc(seg.title || "")}</strong> → ${esc(hall.name)} · ${fmtDate(show.date)} ${esc(show.start)}</p>
      <ul class="reasons fatal">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    </div>
    ${impactHtml}
    ${altsHtml}
    <div class="modal-actions"><button id="modalOkBtn" class="primary">知道了</button></div>
  `);
}

function showAutoReport(result) {
  const reel = currentReel();
  const { report } = result;
  const failHtml = report.failed.length
    ? `<div class="report-fail"><h4>以下 ${report.failed.length} 段无解（受约束限制）</h4>` +
      report.failed.map((s) => {
        const info = report.alternatives[s.id];
        const viable = info?.viableShows?.length
          ? `<div class="viable">本身可去但当前被占：${info.viableShows.map(esc).join("；")}</div>`
          : `<div class="viable none">没有任何场次满足其画幅/设备/授权/时长</div>`;
        return `<div class="fail-card"><strong>${esc(s.code)} ${esc(s.title || "")}</strong>
          ${s.must ? `<span class="must-tag">必放</span>` : ""}
          <small>P${esc(s.priority)} · ${esc(s.aspect)} · ${esc(s.audio)} · ${(s.equipment || []).map(esc).join("/") || "无设备需求"}</small>
          ${viable}</div>`;
      }).join("") + `</div>`
    : `<p class="empty">🎉 全部片段均已成功排入。</p>`;
  openModal("自动排程结果", `
    <p>已排 <strong>${report.scheduledCount}</strong> 段，保留锁定 <strong>${report.lockedCount}</strong> 段，
       无解 <strong class="${report.failed.length ? "danger-text" : ""}">${report.failed.length}</strong> 段。</p>
    ${failHtml}
    <div class="modal-actions"><button id="modalOkBtn" class="primary">完成</button></div>
  `);
}

let toastTimer = null;
function toast(msg, type = "info") {
  els.toast.textContent = msg;
  els.toast.className = "toast show " + type;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

/* ----------------------------- 表单 ----------------------------- */

function resetForm() {
  els.segmentForm.reset();
  els.editId.value = "";
  els.priorityInput.value = "3";
  els.durationInput.value = 600;
  pendingThumb = "";
}
function fillForm(s) {
  els.editId.value = s.id;
  els.codeInput.value = s.code;
  els.titleInput.value = s.title || "";
  els.durationInput.value = s.duration;
  els.aspectInput.value = s.aspect;
  els.audioInput.value = s.audio;
  els.priorityInput.value = s.priority;
  els.sourceInput.value = s.sourceId || "";
  els.licenseStartInput.value = s.licenseStart || "";
  els.licenseEndInput.value = s.licenseEnd || "";
  els.mustInput.checked = !!s.must;
  els.noteInput.value = s.note || "";
  pendingThumb = s.thumb || "";
  els.equipmentInput.querySelectorAll("[data-equip]").forEach((cb) => {
    cb.checked = (s.equipment || []).includes(cb.value);
  });
  els.formSubmitBtn.textContent = "保存修改";
  els.segmentForm.hidden = false;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) return resolve("");
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve("");
    r.readAsDataURL(file);
  });
}

/* 通过文件头魔数辨别真实图片类型，防止改扩展名/MIME 的伪装文件 */
function sniffImageType(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "";
}
function readFileValidatedImage(file) {
  return new Promise((resolve) => {
    if (!file) return resolve({ ok: true, dataUrl: "" });
    const hr = new FileReader();
    hr.onload = () => {
      const real = sniffImageType(hr.result);
      if (!real) return resolve({ ok: false, dataUrl: "" });
      const dr = new FileReader();
      dr.onload = () => resolve({ ok: true, dataUrl: dr.result, real });
      dr.onerror = () => resolve({ ok: false, dataUrl: "" });
      dr.readAsDataURL(file);
    };
    hr.onerror = () => resolve({ ok: false, dataUrl: "" });
    hr.readAsArrayBuffer(file.slice(0, 16));
  });
}
/* 校验 data URL 解码后的真实文件头，识别伪装缩略图 */
function dataUrlIsRealImage(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,/.exec(dataUrl);
  if (!m || !m[1].startsWith("image/")) return false;
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bin = atob(b64.slice(0, 32));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return !!sniffImageType(bytes.buffer);
  } catch { return false; }
}

async function submitSegment(e) {
  e.preventDefault();
  const reel = currentReel();
  const code = els.codeInput.value.trim();
  const duration = Number(els.durationInput.value);
  if (!code) return toast("编号不能为空", "error");
  if (!Number.isFinite(duration) || duration <= 0) return toast("时长必须为正数", "error");
  // 编号重复拦截（同卷）
  const newNorm = normalizeCode(code);
  const dup = reel.segments.find((s) => s.id !== els.editId.value && normalizeCode(s.code) === newNorm);
  if (dup) return toast(`编号 ${code} 与已有「${dup.code}」重复（忽略大小写与空格），请改用其他编号`, "error");
  const licenseStart = els.licenseStartInput.value;
  const licenseEnd = els.licenseEndInput.value;
  if (licenseStart && licenseEnd && licenseStart > licenseEnd) {
    return toast("授权时段非法：起始日晚于结束日", "error");
  }

  const data = {
    code,
    title: els.titleInput.value.trim(),
    duration,
    aspect: els.aspectInput.value,
    audio: els.audioInput.value,
    priority: Number(els.priorityInput.value),
    equipment: [...els.equipmentInput.querySelectorAll("[data-equip]:checked")].map((cb) => cb.value),
    sourceId: els.sourceInput.value.trim(),
    licenseStart, licenseEnd,
    must: els.mustInput.checked,
    note: els.noteInput.value.trim(),
    thumb: pendingThumb
  };
  const editId = els.editId.value;
  if (editId) {
    const s = reel.segments.find((x) => x.id === editId);
    Object.assign(s, data);
    commit(`编辑片段 ${code}`);
  } else {
    reel.segments.push({ id: uid("seg"), ...data });
    commit(`新增片段 ${code}`);
  }
  resetForm();
  els.segmentForm.hidden = true;
}

/* ---------------------- 复制为巡演版本 / 新建卷 ---------------------- */

function copyAsTour() {
  const src = currentReel();
  const copy = clone(src);
  copy.id = uid("reel");
  copy.name = src.name + " · 巡演副本 " + new Date().toLocaleDateString("zh-CN");
  copy.tour = true;
  copy.copiedFrom = src.id;
  copy.placed = [];
  // 复制卷中的片段使用全新 ID 但保留 sourceId，形成独立巡演版本
  const idMap = new Map();
  copy.segments.forEach((s) => { const nid = uid("seg"); idMap.set(s.id, nid); s.id = nid; });
  copy.shows.forEach((s) => { s.id = uid("s"); });
  copy.halls.forEach((h) => { h.id = uid("h"); });
  // 重建场次的 hallId
  const oldHallMap = new Map();
  src.halls.forEach((h, i) => oldHallMap.set(h.id, copy.halls[i].id));
  copy.shows.forEach((sh) => { sh.hallId = oldHallMap.get(sh.hallId); });
  state.reels.push(copy);

  const plan = {
    id: uid("plan"), name: "主方案", reelId: copy.id,
    placed: copy.shows.map((sh) => ({ id: uid("pl"), showId: sh.id, segmentId: null, locked: false })),
    createdAt: Date.now()
  };
  state.plans.push(plan);
  state.currentReelId = copy.id;
  state.currentPlanId = plan.id;
  commit("复制为巡演版本");
  toast("已生成独立巡演版本（片段/影厅/场次为全新副本）");
}

function newTourReel() {
  const base = defaultState();
  const reel = base.reels[0];
  reel.id = uid("reel");
  reel.name = "新巡演卷 " + new Date().toLocaleDateString("zh-CN");
  reel.shows.forEach((s) => { s.id = uid("s"); });
  reel.halls.forEach((h) => { h.id = uid("h"); });
  const oldH = ["h1", "h2", "h3"];
  reel.halls.forEach((h, i) => {
    reel.shows.filter((s) => s.hallId === oldH[i]).forEach((s) => (s.hallId = h.id));
  });
  reel.segments = [];
  state.reels.push(reel);
  const plan = {
    id: uid("plan"), name: "主方案", reelId: reel.id,
    placed: reel.shows.map((sh) => ({ id: uid("pl"), showId: sh.id, segmentId: null, locked: false })),
    createdAt: Date.now()
  };
  state.plans.push(plan);
  state.currentReelId = reel.id;
  state.currentPlanId = plan.id;
  commit("新建巡演卷");
}

/* ----------------------------- 方案管理 ----------------------------- */

function saveAsNewPlan() {
  const reel = currentReel();
  const cur = currentPlan();
  const name = `方案 ${state.plans.filter((p) => p.reelId === reel.id).length + 1} · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  const plan = { id: uid("plan"), name, reelId: reel.id, placed: clone(cur ? cur.placed : []), createdAt: Date.now() };
  state.plans.push(plan);
  state.currentPlanId = plan.id;
  commit("另存新方案");
  toast(`已另存为「${name}」，可在方案间切换对比`);
}

function showCompare() {
  const reel = currentReel();
  const plans = state.plans.filter((p) => p.reelId === reel.id);
  if (plans.length < 1) return toast("暂无方案");
  const summary = plans.map((p) => {
    const placed = effectivePlaced(reel, p).filter((x) => x.segmentId);
    const conflicts = computeConflicts(reel, p);
    const mins = Math.round(placed.reduce((sum, x) => sum + Number(segById(reel, x.segmentId)?.duration || 0) / 60, 0));
    const must = reel.segments.filter((s) => s.must).length;
    const mustPlaced = reel.segments.filter((s) => s.must && placed.some((x) => x.segmentId === s.id)).length;
    return { p, placed: placed.length, locked: placed.filter((x) => x.locked).length, conflicts: conflicts.length, mins, must, mustPlaced };
  });
  const rows = summary.map((x) => `
    <tr>
      <td><strong>${esc(x.p.name)}</strong>${x.p.id === state.currentPlanId ? `<span class="placed-tag">当前</span>` : ""}</td>
      <td>${x.placed}</td><td>${x.mustPlaced}/${x.must}</td><td>${x.mins}</td>
      <td>${x.locked}</td>
      <td class="${x.conflicts ? "danger-text" : ""}">${x.conflicts}</td>
      <td><button class="mini" data-switch-plan="${esc(x.p.id)}">切换</button>
          <button class="mini danger" data-del-plan="${esc(x.p.id)}">删除</button></td>
    </tr>`).join("");
  openModal("方案对比", `
    <table class="compare-table">
      <thead><tr><th>方案</th><th>已排段</th><th>必放覆盖</th><th>分钟</th><th>锁定</th><th>冲突</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div id="planDiff" class="plan-diff"></div>
    <div class="modal-actions"><button id="modalOkBtn" class="primary">关闭</button></div>
  `);
  // 绑定行内对比
  els.modalBody.querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-switch-plan],[data-del-plan]")) return;
      const planId = tr.querySelector("[data-switch-plan]")?.dataset.switchPlan;
      if (planId) renderPlanDiff(reel, planId);
    });
  });
}

function renderPlanDiff(reel, otherPlanId) {
  const a = currentPlan();
  const b = state.plans.find((p) => p.id === otherPlanId);
  if (!a || !b || a.id === b.id) { els.modalBody.querySelector("#planDiff").innerHTML = ""; return; }
  const mapA = new Map(effectivePlaced(reel, a).filter((p) => p.segmentId).map((p) => [p.segmentId, p.showId]));
  const mapB = new Map(effectivePlaced(reel, b).filter((p) => p.segmentId).map((p) => [p.segmentId, p.showId]));
  const lines = [];
  for (const s of reel.segments) {
    const sa = mapA.get(s.id), sb = mapB.get(s.id);
    if (sa === sb) continue;
    const name = (id) => id ? (() => { const sh = showById(reel, id); return `${hallById(reel, sh.hallId).name} ${fmtDate(sh.date)} ${sh.start}`; })() : "未排";
    lines.push(`<li><strong>${esc(s.code)}</strong>：${name(sa)} → ${name(sb)}</li>`);
  }
  const box = els.modalBody.querySelector("#planDiff");
  box.innerHTML = `<h4>与「${esc(b.name)}」的差异（点击行查看）</h4><ul class="diff-list">${lines.join("") || "<li>两方案排片完全相同</li>"}</ul>`;
}

/* ----------------------------- 自动排程动作 ----------------------------- */

function runAuto(opts = {}) {
  const reel = currentReel();
  const plan = currentPlan();
  if (!plan) return toast("请先创建方案");
  const result = autoSchedule(reel, plan, { keepLocked: true, ...opts });
  plan.placed = result.placed;
  commit(opts.mustOnly ? "自动排程（仅必放）" : "自动排程");
  showAutoReport(result);
}

/* ----------------------------- 批量锁场 ----------------------------- */

function toggleBatchMode() { batchMode = !batchMode; render(); }
function batchApply(lock) {
  const plan = currentPlan();
  const checked = [...els.scheduleGrid.querySelectorAll("[data-batch-slot]:checked")].map((cb) => cb.dataset.batchSlot);
  if (!checked.length) return toast("请先勾选场次");
  let n = 0;
  checked.forEach((showId) => {
    plan.placed.filter((p) => p.showId === showId && p.segmentId).forEach((p) => {
      if (p.locked !== lock) { p.locked = lock; n++; }
    });
  });
  commit(lock ? `批量锁定 ${n} 个安排` : `批量解锁 ${n} 个安排`);
  toast(`${lock ? "锁定" : "解锁"} ${n} 个安排`);
}

/* ----------------------------- 导出 / 导入 ----------------------------- */

function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tour-schedule-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 导入校验。返回 { errors:[], warnings:[], data }。
 * 拦截：重复编号、非法时段、伪装缩略图、结构异常。异常数据绝不进入页面。
 */
function validateImport(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { errors: ["文件不是有效的 JSON 对象"], data: null };
  }
  if (!Array.isArray(payload.reels) || !payload.reels.length) {
    return { errors: ["缺少 reels 数组或为空"], data: null };
  }
  const cleanReels = [];
  payload.reels.forEach((r, ri) => {
    const tag = `第${ri + 1}卷`;
    if (!r || typeof r !== "object") { errors.push(`${tag}：不是对象，已丢弃`); return; }
    if (!Array.isArray(r.segments) || !Array.isArray(r.shows) || !Array.isArray(r.halls)) {
      errors.push(`${tag}：缺少 segments/shows/halls，已丢弃`); return;
    }
    const codeByNorm = new Map(); // normalizeCode -> 原始（trim 后）编号
    const segs = [];
    r.segments.forEach((s, si) => {
      const stag = `${tag} 片段#${si + 1}`;
      if (!s || typeof s !== "object") { errors.push(`${stag}：不是对象，已跳过`); return; }
      if (typeof s.code !== "string") { errors.push(`${stag}：缺少编号，已跳过`); return; }
      const rawCode = s.code;
      const code = rawCode.trim();
      const norm = normalizeCode(code);
      if (!norm) { errors.push(`${stag}：编号为空白，已跳过（原值 ${JSON.stringify(rawCode)}）`); return; }
      if (codeByNorm.has(norm)) {
        errors.push(`${stag}：重复编号「${code}」与同卷「${codeByNorm.get(norm)}」（忽略大小写与空格后相同），已跳过`);
        return;
      }
      const dur = Number(s.duration);
      if (!Number.isFinite(dur) || dur <= 0) { errors.push(`${stag}「${code}」：时长非法，已跳过`); return; }
      if (s.licenseStart && s.licenseEnd && s.licenseStart > s.licenseEnd) {
        errors.push(`${stag}「${code}」：授权时段非法（起>止），已跳过`); return;
      }
      if (s.licenseStart && !isValidCalendarDate(s.licenseStart)) {
        errors.push(`${stag}「${code}」：授权起日期「${s.licenseStart}」不是真实日历日期，已跳过`); return;
      }
      if (s.licenseEnd && !isValidCalendarDate(s.licenseEnd)) {
        errors.push(`${stag}「${code}」：授权止日期「${s.licenseEnd}」不是真实日历日期，已跳过`); return;
      }
      // 伪装缩略图：声明 data:image 但真实文件头不是图片
      if (s.thumb) {
        if (typeof s.thumb !== "string") { errors.push(`${stag}「${code}」：缩略图字段非法，已跳过`); return; }
        if (!dataUrlIsRealImage(s.thumb)) {
          errors.push(`${stag}「${code}」：缩略图文件头与图片声明不符（伪装缩略图），已清除该字段`);
          s.thumb = "";
        }
      }
      codeByNorm.set(norm, code);
      segs.push({
        id: uid("seg"), code, title: String(s.title || ""), duration: dur,
        aspect: ASPECTS.includes(s.aspect) ? s.aspect : "1.85",
        audio: AUDIOS.includes(s.audio) ? s.audio : "立体声",
        priority: Math.min(5, Math.max(1, Number(s.priority) || 3)),
        equipment: Array.isArray(s.equipment) ? s.equipment.filter((e) => EQUIPMENT.includes(e)) : [],
        sourceId: String(s.sourceId || ""),
        licenseStart: s.licenseStart || "", licenseEnd: s.licenseEnd || "",
        must: !!s.must, note: String(s.note || ""), thumb: s.thumb || ""
      });
    });

    // 影厅 / 场次清洗（保留原始顺序构建映射，避免 filter 后索引错位）
    const halls = [];
    const hallIdMap = new Map();
    r.halls.forEach((oh) => {
      if (oh && oh.id && oh.name) {
        const nh = {
          id: uid("h"), name: String(oh.name), capacity: Number(oh.capacity) || 100,
          aspect: ASPECTS.includes(oh.aspect) ? oh.aspect : "1.85",
          audio: AUDIOS.includes(oh.audio) ? oh.audio : "立体声",
          equipment: Array.isArray(oh.equipment) ? oh.equipment.filter((e) => EQUIPMENT.includes(e)) : [],
          turnMinutes: Math.max(0, Number(oh.turnMinutes) || 0)
        };
        halls.push(nh);
        hallIdMap.set(oh.id, nh.id);
      }
    });
    const shows = [];
    r.shows.forEach((sh) => {
      if (!sh || !hallIdMap.has(sh.hallId)) return;
      if (!isValidCalendarDate(sh.date)) {
        errors.push(`${tag}：场次日期「${sh.date}」不是真实日历日期，已跳过`); return;
      }
      const stOk = isValidClockTime(sh.start), enOk = isValidClockTime(sh.end);
      if (!stOk || !enOk) {
        errors.push(`${tag}：场次时刻非法（${sh.start}–${sh.end}，须为 00:00–23:59），已跳过`); return;
      }
      if (hmToMinutes(sh.end) <= hmToMinutes(sh.start)) {
        errors.push(`${tag}：场次时段 ${sh.start}-${sh.end} 结束不晚于开始，已跳过`); return;
      }
      shows.push({ id: uid("s"), hallId: hallIdMap.get(sh.hallId), date: sh.date, start: sh.start, end: sh.end });
    });
    if (!halls.length || !shows.length) { errors.push(`${tag}：缺少有效影厅或场次，整卷丢弃`); return; }

    cleanReels.push({
      id: uid("reel"), name: String(r.name || "导入巡演卷"), tour: true, copiedFrom: "",
      halls, shows, segments: segs, placed: []
    });
  });

  if (!cleanReels.length) return { errors: errors.length ? errors : ["没有可导入的有效数据"], data: null };
  return { errors, data: cleanReels };
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(reader.result); }
    catch { openModal("导入失败", `<p class="danger-text">文件不是合法 JSON，未导入任何数据。</p><div class="modal-actions"><button id="modalOkBtn" class="primary">关闭</button></div>`); return; }
    const { errors, data } = validateImport(payload);
    if (!data) {
      openModal("导入被拦截", `<ul class="reasons fatal">${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
        <p>异常数据未进入页面。</p><div class="modal-actions"><button id="modalOkBtn" class="primary">关闭</button></div>`);
      return;
    }
    const errHtml = errors.length
      ? `<div class="report-fail"><h4>已拦截 / 清洗 ${errors.length} 项</h4><ul class="reasons">${errors.slice(0, 50).map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
      : `<p class="empty">校验全部通过，无异常。</p>`;
    openModal(`导入预览：${data.length} 卷有效`, `
      ${errHtml}
      <p>确认后将把这些巡演卷加入当前工作台（生成全新 ID，不覆盖现有数据）。</p>
      <div class="modal-actions">
        <button id="importConfirmBtn" class="primary">确认导入 ${data.length} 卷</button>
        <button id="modalOkBtn">取消</button>
      </div>`);
    els.modalBody.querySelector("#importConfirmBtn").addEventListener("click", () => {
      data.forEach((reel) => {
        state.reels.push(reel);
        const plan = { id: uid("plan"), name: "主方案", reelId: reel.id,
          placed: reel.shows.map((sh) => ({ id: uid("pl"), showId: sh.id, segmentId: null, locked: false })),
          createdAt: Date.now() };
        state.plans.push(plan);
      });
      state.currentReelId = data[0].id;
      state.currentPlanId = state.plans.find((p) => p.reelId === data[0].id).id;
      commit("导入巡演卷");
      closeModal();
      toast(`已导入 ${data.length} 卷`);
    });
  };
  reader.readAsText(file);
}

/* ----------------------------- 拖拽 ----------------------------- */

let dragSegId = null;
let dragPlacedId = null;

/* ----------------------------- 事件绑定 ----------------------------- */

function bind() {
  els.reelSelect.addEventListener("change", () => {
    state.currentReelId = els.reelSelect.value;
    render(); persist();
  });
  els.planSelect.addEventListener("change", () => {
    state.currentPlanId = els.planSelect.value;
    commit("切换方案");
  });
  els.copyTourBtn.addEventListener("click", copyAsTour);
  els.newTourBtn.addEventListener("click", newTourReel);
  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);
  els.autoBtn.addEventListener("click", () => runAuto({}));
  els.savePlanBtn.addEventListener("click", saveAsNewPlan);
  els.compareBtn.addEventListener("click", showCompare);
  els.recheckBtn.addEventListener("click", () => { renderConflicts(); renderGrid(); toast("已重新校验"); });
  els.exportBtn.addEventListener("click", exportJSON);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) handleImportFile(f); e.target.value = ""; });

  els.batchLockBtn.addEventListener("click", toggleBatchMode);
  els.batchExit.addEventListener("click", toggleBatchMode);
  els.batchApplyLock.addEventListener("click", () => batchApply(true));
  els.batchApplyUnlock.addEventListener("click", () => batchApply(false));
  els.batchAll.addEventListener("change", (e) => {
    els.scheduleGrid.querySelectorAll("[data-batch-slot]").forEach((cb) => (cb.checked = e.target.checked));
  });

  els.toggleFormBtn.addEventListener("click", () => {
    els.segmentForm.hidden = !els.segmentForm.hidden;
    if (!els.segmentForm.hidden) { resetForm(); els.formSubmitBtn.textContent = "加入巡演卷"; els.codeInput.focus(); }
  });
  els.formCancelBtn.addEventListener("click", () => { resetForm(); els.segmentForm.hidden = true; });
  els.segmentForm.addEventListener("submit", submitSegment);
  els.thumbInput.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    // 伪装缩略图：MIME 与真实文件头都要为图片，否则拒绝
    const res = await readFileValidatedImage(f);
    if (!res.ok) {
      toast(`「${f.name}」真实文件头不是图片（伪装缩略图），已拒绝`, "error");
      e.target.value = "";
      pendingThumb = "";
      return;
    }
    pendingThumb = res.dataUrl;
    toast("缩略图已校验并载入");
  });
  els.searchInput.addEventListener("input", renderLibrary);
  els.mustOnlyFilter.addEventListener("change", renderLibrary);

  // 素材库：编辑 / 删除 / 拖拽
  els.segmentList.addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit]");
    const dl = e.target.closest("[data-del]");
    if (ed) {
      const s = segById(currentReel(), ed.dataset.edit);
      if (s) fillForm(s);
    }
    if (dl) {
      const id = dl.dataset.del;
      const code = segById(currentReel(), id)?.code;
      const lockedElsewhere = currentPlan()?.placed.some((p) => p.segmentId === id && p.locked);
      if (lockedElsewhere) return toast("该片段在锁定场次中，不能删除", "error");
      currentReel().segments = currentReel().segments.filter((x) => x.id !== id);
      currentPlan().placed.forEach((p) => { if (p.segmentId === id) p.segmentId = null; });
      commit(`删除片段 ${code || ""}`);
    }
  });

  // 网格：撤下 / 锁定点击 / 替代片段排入
  els.scheduleGrid.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) { removeFromSlot(rm.dataset.remove); return; }
    const slot = e.target.closest(".slot-card");
    if (slot && e.target === slot) {
      // 点击锁定卡片提示；点击冲突卡片显示原因
      const p = currentPlan().placed.find((x) => x.id === slot.dataset.placed);
      if (p?.locked) return toast("🔒 该安排已锁定，不能改动", "error");
    }
  });
  // 双击槽位切换锁定
  els.scheduleGrid.addEventListener("dblclick", (e) => {
    const card = e.target.closest("[data-placed]");
    if (card) toggleSlotLock(card.dataset.placed);
  });

  // 弹窗内：关闭 / 替代排入 / 方案切换
  els.modalOverlay.addEventListener("click", (e) => {
    if (e.target === els.modalOverlay || e.target.closest("#modalOkBtn") || e.target.closest("#modalCloseBtn")) closeModal();
    const alt = e.target.closest("[data-alt-place]");
    if (alt) { closeModal(); placeSegment(alt.dataset.altPlace, alt.dataset.altShow); return; }
    const sw = e.target.closest("[data-switch-plan]");
    if (sw) { state.currentPlanId = sw.dataset.switchPlan; commit("切换方案"); showCompare(); return; }
    const dp = e.target.closest("[data-del-plan]");
    if (dp) {
      if (state.plans.filter((p) => p.reelId === currentReel().id).length <= 1) return toast("至少保留一个方案");
      state.plans = state.plans.filter((p) => p.id !== dp.dataset.delPlan);
      if (state.currentPlanId === dp.dataset.delPlan) state.currentPlanId = state.plans[0].id;
      commit("删除方案"); showCompare();
    }
  });

  /* ---- 素材库卡片 -> 场次 拖拽 ---- */
  els.segmentList.addEventListener("dragstart", (e) => {
    const card = e.target.closest("[data-seg]");
    if (!card) return;
    dragSegId = card.dataset.seg; dragPlacedId = null;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragSegId);
    card.classList.add("dragging");
  });
  els.segmentList.addEventListener("dragend", (e) => {
    e.target.closest("[data-seg]")?.classList.remove("dragging");
    dragSegId = null;
  });

  /* ---- 已排卡片 -> 其他场次 移动 ---- */
  els.scheduleGrid.addEventListener("dragstart", (e) => {
    const card = e.target.closest("[data-placed]");
    if (!card) return;
    const p = currentPlan().placed.find((x) => x.id === card.dataset.placed);
    if (p?.locked) { e.preventDefault(); toast("锁定安排不能拖拽", "error"); return; }
    dragPlacedId = card.dataset.placed; dragSegId = p.segmentId;
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  els.scheduleGrid.addEventListener("dragend", () => {
    document.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
    document.querySelectorAll(".drop-over").forEach((n) => n.classList.remove("drop-over"));
    dragSegId = null; dragPlacedId = null;
  });
  els.scheduleGrid.addEventListener("dragover", (e) => {
    const drop = e.target.closest(".slot-drop, .show-block");
    if (!drop || !dragSegId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".drop-over").forEach((n) => n.classList.remove("drop-over"));
    (drop.querySelector?.(".slot-drop") || drop).classList.add("drop-over");
  });
  els.scheduleGrid.addEventListener("drop", (e) => {
    const drop = e.target.closest("[data-show]");
    if (!drop || !dragSegId) return;
    e.preventDefault();
    const showId = drop.dataset.show;
    const segId = dragSegId;
    dragSegId = null; dragPlacedId = null;
    document.querySelectorAll(".drop-over").forEach((n) => n.classList.remove("drop-over"));
    placeSegment(segId, showId);
  });

  // 键盘撤销/重做
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  });
}

/* ----------------------------- 启动 ----------------------------- */

function init() {
  cacheEls();
  renderEquipmentChecks();
  bind();
  render();
}

state = loadState();
loadHistory();
if (!checkpoint) checkpoint = clone(state);
init();

/* 只读调试 / 自动化钩子（不修改数据） */
window.__tourDesk = {
  state: () => state,
  history: () => history,
  conflicts: () => computeConflicts(currentReel(), currentPlan()),
  validateImport,
  autoSchedule: (opts) => autoSchedule(currentReel(), currentPlan(), opts)
};
