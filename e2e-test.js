"use strict";
/* 真实浏览器端到端走测：Chromium + Playwright */
const { chromium } = require("playwright");

const URL = "http://localhost:8137/index.html";
let passed = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name + " " + extra); console.error(`  ❌ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dispatchDrag(page, fromSel, toSel) {
  const result = await page.evaluate(({ fromSel, toSel }) => {
    const from = document.querySelector(fromSel);
    const to = document.querySelector(toSel);
    if (!from || !to) return { error: `missing ${!from ? fromSel : toSel}` };
    const dt = new DataTransfer();
    const fire = (el, type, opts = {}) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...opts });
      el.dispatchEvent(ev);
      return ev;
    };
    fire(from, "dragstart");
    fire(to, "dragover");
    fire(to, "drop");
    fire(from, "dragend");
    return { ok: true };
  }, { fromSel, toSel });
  return result;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(URL);
  await page.evaluate(() => localStorage.clear()); // 仅首次清理，不影响后续 reload
  await page.reload();
  await page.waitForSelector(".lib-card");

  const state = () => page.evaluate(() => window.__tourDesk.state());
  const meta = async () => {
    const s = await state();
    const reel = s.reels.find((r) => r.id === s.currentReelId);
    const plan = s.plans.find((p) => p.id === s.currentPlanId && p.reelId === reel.id);
    const showIds = new Set(reel.shows.map((x) => x.id));
    const placed = plan.placed.filter((p) => showIds.has(p.showId) && p.segmentId);
    return { s, reel, plan, placed };
  };
  const segId = async (code) => { const { reel } = await meta(); return reel.segments.find((x) => x.code === code)?.id; };
  const showId = async (hallName, start) => {
    const { reel } = await meta();
    const h = reel.halls.find((x) => x.name === hallName);
    return reel.shows.find((x) => x.hallId === h.id && x.start === start)?.id;
  };
  const placementOf = async (code) => {
    const { reel, placed } = await meta();
    const sid = reel.segments.find((x) => x.code === code)?.id;
    const p = placed.find((x) => x.segmentId === sid);
    return p || null;
  };
  const modalOpen = () => page.$eval("#modalOverlay", (el) => !el.hidden).catch(() => false);
  const modalText = () => page.$eval("#modalBody", (el) => el.innerText).catch(() => "");
  const modalTitle = () => page.$eval("#modalTitle", (el) => el.innerText).catch(() => "");
  const closeModal = async () => {
    if (await modalOpen()) { await page.click("#modalOkBtn").catch(() => {}); await sleep(60); }
  };
  const stat = (id) => page.$eval("#" + id, (el) => el.textContent.trim());

  /* ---------- 0. 初始数据 ---------- */
  console.log("\n[0] 初始数据");
  let { reel, plan, placed } = await meta();
  check("初始有 3 个影厅", reel.halls.length === 3);
  check("初始有 9 个片段", reel.segments.length === 9);
  check("初始有 8 个场次", reel.shows.length === 8);
  check("初始锁定 1 个安排（T-102）", placed.filter((p) => p.locked).length === 1);
  check("初始必放未排 = 2（T-101、T-109）", await stat("statMust") === "2", await stat("statMust"));
  check("初始冲突清单含无解必放 T-109", (await page.$eval("#conflictList", (e) => e.innerText)).includes("T-109"));
  check("页面无 JS 错误", errors.length === 0, errors.join(" | "));

  /* ---------- 1. 正常排程（拖拽合法片段到合法场次） ---------- */
  console.log("\n[1] 正常排程");
  {
    const sid = await segId("T-105"); // 1.85 立体声 数字机+字幕机
    const sh = await showId("一号厅", "14:00"); // s11 day0
    const r = await dispatchDrag(page, `.lib-card[data-seg="${sid}"]`, `.show-block[data-show="${sh}"]`);
    check("拖拽执行无错误", r.ok, JSON.stringify(r.error || ""));
    await sleep(60);
    const p = await placementOf("T-105");
    check("T-105 已排入目标场次", !!p && p.showId === sh);
    check("无弹窗冲突", !(await modalOpen()));
    check("必放未排仍为 2", await stat("statMust") === "2");
  }

  /* ---------- 2. 无解冲突（画幅/声轨/设备不兼容 → 弹窗给原因+替代+影响） ---------- */
  console.log("\n[2] 无解冲突");
  {
    const sid = await segId("T-109"); // 2.39 单声道 胶片机+杜比+宽幕
    const sh = await showId("三号厅", "13:30"); // 1.37 单声道 胶片机+遮光幕
    await dispatchDrag(page, `.lib-card[data-seg="${sid}"]`, `.show-block[data-show="${sh}"]`);
    await sleep(60);
    const open = await modalOpen();
    const txt = await modalText();
    check("弹出冲突弹窗", open);
    check("给出画幅不匹配原因", txt.includes("画幅不匹配"));
    check("给出设备不足原因", txt.includes("设备不足") && txt.includes("杜比处理器"));
    check("提供替代片段区", txt.includes("可替代片段"));
    check("T-109 未被排入", !(await placementOf("T-109")));
    await closeModal();
  }

  /* ---------- 3. 替代片段（授权未到 → 推荐可放片段，点击直接排入） ---------- */
  console.log("\n[3] 替代片段");
  {
    const sid = await segId("T-107"); // 授权明天起
    const sh = await showId("一号厅", "19:00"); // s12 day0
    await dispatchDrag(page, `.lib-card[data-seg="${sid}"]`, `.show-block[data-show="${sh}"]`);
    await sleep(60);
    let txt = await modalText();
    check("授权冲突给出原因", (await modalOpen()) && txt.includes("授权未开始"));
    // 替代列表中应出现合法片段（T-101：1.85 立体声 数字机，授权覆盖 day0）
    const t101 = await segId("T-101");
    const altBtn = await page.$(`[data-alt-place="${t101}"]`);
    check("替代列表包含 T-101", !!altBtn);
    if (altBtn) { await altBtn.click(); await sleep(60); }
    const p = await placementOf("T-101");
    check("点击替代片段 T-101 直接排入该场", !!p && p.showId === sh);
    check("必放未排降为 1", await stat("statMust") === "1", await stat("statMust"));
  }

  /* ---------- 4. 同素材互斥 ---------- */
  console.log("\n[4] 同素材互斥");
  {
    const sid = await segId("T-104"); // source M2，与锁定的 T-102 同素材同日
    const sh = await showId("二号厅", "19:30"); // s22 day1，T-102 已锁在此
    await dispatchDrag(page, `.lib-card[data-seg="${sid}"]`, `.show-block[data-show="${sh}"]`);
    await sleep(60);
    const txt = await modalText();
    check("同素材同日给出互斥原因", (await modalOpen()) && txt.includes("同素材互斥"), txt.slice(0, 80));
    check("T-104 未排入", !(await placementOf("T-104")));
    await closeModal();
    // 换一天（day2 s23 15:00 二号厅，2.39/5.1 匹配）应可排
    const sh2 = await showId("二号厅", "15:00");
    await dispatchDrag(page, `.lib-card[data-seg="${sid}"]`, `.show-block[data-show="${sh2}"]`);
    await sleep(60);
    const p = await placementOf("T-104");
    check("同素材跨天可排入二号厅", !!p && p.showId === sh2);
  }

  /* ---------- 5. 锁定不可改动（移动锁定片段被拒） ---------- */
  console.log("\n[5] 锁定保护");
  {
    const t102 = await placementOf("T-102");
    check("T-102 处于锁定", t102 && t102.locked);
    const s22 = t102.showId;
    const target = await showId("三号厅", "13:30");
    await dispatchDrag(page, `.slot-card[data-placed="${t102.id}"]`, `.show-block[data-show="${target}"]`);
    await sleep(60);
    const after = await placementOf("T-102");
    check("锁定片段拖拽后仍在原场次", after.showId === s22 && after.locked);
    // 撤下按钮不存在于锁定卡
    const noX = await page.$(`.slot-card[data-placed="${t102.id}"] .slot-x`);
    check("锁定卡片没有撤下按钮", !noX);
  }

  /* ---------- 6. 重排（网格内移动已排片段，含失败移动） ---------- */
  console.log("\n[6] 重排");
  {
    // 6a 锁定片段 T-102 移到授权/画幅不符场次 → 拒绝
    const t102 = await placementOf("T-102");
    const s32 = await showId("三号厅", "19:00");
    await dispatchDrag(page, `.slot-card[data-placed="${t102.id}"]`, `.show-block[data-show="${s32}"]`);
    await sleep(60);
    check("移动锁定片段被拦截（toast，不动）", (await placementOf("T-102")).showId === t102.showId);
    // 6b 合法移动 T-104：二号厅 day2 15:00 → 二号厅 day0 15:00（2.39 匹配，授权内）
    const t104 = await placementOf("T-104");
    const { reel } = await meta();
    const h2 = reel.halls.find((x) => x.name === "二号厅").id;
    const dates = [...new Set(reel.shows.map((x) => x.date))].sort();
    const targetId = reel.shows.find((x) => x.hallId === h2 && x.start === "15:00" && x.date === dates[0]).id;
    await dispatchDrag(page, `.slot-card[data-placed="${t104.id}"]`, `.show-block[data-show="${targetId}"]`);
    await sleep(60);
    const moved = (await placementOf("T-104"));
    check("T-104 网格内重排到二号厅当日场次", !!moved && moved.showId === targetId, `got ${moved?.showId}`);
  }

  /* ---------- 7. 双击锁定/解锁（非锁定片段） ---------- */
  console.log("\n[7] 双击锁定切换");
  {
    const t105 = await placementOf("T-105");
    await page.dblclick(`.slot-card[data-placed="${t105.id}"]`);
    await sleep(50);
    check("双击后 T-105 被锁定", (await placementOf("T-105")).locked === true);
    await page.dblclick(`.slot-card[data-placed="${t105.id}"]`);
    await sleep(50);
    check("再次双击解锁", (await placementOf("T-105")).locked === false);
  }

  /* ---------- 8. 自动排程（保留锁定；无解片段进入报告与冲突清单） ---------- */
  console.log("\n[8] 自动排程");
  {
    await page.click("#autoBtn");
    await page.waitForSelector("#modalOverlay:not([hidden])");
    const txt = await modalText();
    check("自动排程报告出现", (await modalTitle()).includes("自动排程结果") && txt.includes("已排"));
    check("报告标注 T-109 无解", txt.includes("T-109"));
    check("报告说明无任何场次满足", txt.includes("没有任何场次满足"));
    await closeModal();
    const t109 = await placementOf("T-109");
    check("T-109 自动排程后仍未排", !t109);
    const t102 = await placementOf("T-102");
    check("锁定的 T-102 保留且仍锁定", t102 && t102.locked);
    // 其余可解片段大多被排入
    const { reel, placed: pl } = await meta();
    const placedCodes = new Set(pl.map((p) => reel.segments.find((s) => s.id === p.segmentId)?.code));
    check("可排片段 T-103 被自动排入", placedCodes.has("T-103"));
    check("冲突清单仍只缺 T-109（必放未排）", await stat("statMust") === "1", await stat("statMust"));
  }

  /* ---------- 9. 撤销 / 重做 ---------- */
  console.log("\n[9] 撤销/重做");
  {
    const beforeHist = await page.evaluate(() => window.__tourDesk.history().past.length);
    const sigOf = async () => {
      const { reel, placed } = await meta();
      return placed
        .map((p) => reel.segments.find((s) => s.id === p.segmentId)?.code + "@" + p.showId + (p.locked ? "L" : ""))
        .sort().join("|");
    };
    const beforeSig = await sigOf();
    await page.click("#undoBtn");
    await sleep(60);
    const afterSig = await sigOf();
    check("撤销后排片内容发生变化", afterSig !== beforeSig);
    check("撤销栈减少", (await page.evaluate(() => window.__tourDesk.history().past.length)) === beforeHist - 1);
    await page.click("#redoBtn");
    await sleep(60);
    check("重做后排片内容恢复", (await sigOf()) === beforeSig);
    // 键盘 Ctrl+Z 也可撤销
    await page.keyboard.press("Control+z");
    await sleep(60);
    check("Ctrl+Z 撤销生效", (await sigOf()) === afterSig);
    await page.keyboard.press("Control+Shift+z");
    await sleep(60);
    check("Ctrl+Shift+Z 重做恢复", (await sigOf()) === beforeSig);
  }

  /* ---------- 10. 方案另存 / 切换 / 对比 ---------- */
  console.log("\n[10] 方案管理");
  {
    const m0 = await meta();
    const planCountBefore = m0.s.plans.filter((p) => p.reelId === m0.reel.id).length;
    await page.click("#savePlanBtn");
    await sleep(60);
    const { s, reel } = await meta();
    const plansNow = s.plans.filter((p) => p.reelId === reel.id);
    check("另存出新方案", plansNow.length === planCountBefore + 1);

    // 切回主方案，撤下 T-103，制造差异
    const mainPlan = plansNow.find((p) => p.name === "主方案");
    await page.selectOption("#planSelect", mainPlan.id);
    await sleep(60);
    const t103 = await placementOf("T-103");
    check("主方案中 T-103 已排", !!t103);
    await page.click(`.slot-card[data-placed="${t103.id}"] .slot-x`);
    await sleep(60);
    check("主方案撤下 T-103", !(await placementOf("T-103")));

    // 打开方案对比，点另一方案行（非按钮）查看差异
    await page.click("#compareBtn");
    await sleep(60);
    const cmpTxt = await modalText();
    check("对比表列出两个方案", cmpTxt.includes("主方案"));
    const otherPlan = plansNow.find((p) => p.name !== "主方案");
    // 点击另一方案所在行（避开“切换/删除”按钮）以渲染差异
    await page.evaluate((id) => {
      const btn = document.querySelector(`[data-switch-plan="${id}"]`);
      const row = btn.closest("tr");
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, otherPlan.id);
    await sleep(80);
    const txt2 = await modalText();
    check("差异区显示 T-103 未排→已排", txt2.includes("T-103") && txt2.includes("→"), txt2.slice(0, 120));
    // 通过“切换”按钮切到另一方案
    await page.click(`[data-switch-plan="${otherPlan.id}"]`);
    await sleep(80);
    await closeModal();
    check("切换方案后 T-103 在另一方案中仍已排", !!(await placementOf("T-103")));
  }

  /* ---------- 11. 批量锁场 ---------- */
  console.log("\n[11] 批量锁场");
  {
    const lockBefore = (await meta()).placed.filter((p) => p.locked).length;
    await page.click("#batchLockBtn");
    await sleep(50);
    check("进入批量模式显示勾选条", await page.$eval("#batchBar", (e) => !e.hidden));
    // 勾选第一个未锁定且有片段的场次
    const checked = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll("[data-batch-slot]")];
      const target = boxes.find((cb) => {
        const block = cb.closest(".show-block");
        return block && block.querySelector(".slot-card:not(.locked)");
      });
      if (target) { target.checked = true; return target.dataset.batchSlot; }
      return null;
    });
    check("找到可批量锁定的场次", !!checked);
    await page.click("#batchApplyLock");
    await sleep(60);
    const lockAfter = (await meta()).placed.filter((p) => p.locked).length;
    check("批量锁定后锁定数增加", lockAfter > lockBefore, `${lockBefore}->${lockAfter}`);
    await page.click("#batchExit").catch(() => {});
  }

  /* ---------- 12. 导入异常：重复编号 / 非法时段 / 伪装缩略图 / 空白编号 / 非法日历时刻 ---------- */
  console.log("\n[12] 导入异常拦截");
  {
    const validHall = { id: "hh1", name: "导入厅", capacity: 100, aspect: "1.85", audio: "立体声", equipment: ["数字机"], turnMinutes: 15 };
    const validShow = { id: "ss1", hallId: "hh1", date: "2026-01-05", start: "14:00", end: "16:00" };
    const good = (code, extra = {}) => ({ code, duration: 600, aspect: "1.85", audio: "立体声", equipment: ["数字机"], ...extra });
    // 伪装缩略图：声明 image/png，实际是文本字节（EF BB BF + "test"）
    const fakePng = "data:image/png;base64," + Buffer.from([0xef, 0xbb, 0xbf]).toString("base64") + Buffer.from("test").toString("base64");
    const payload = {
      reels: [
        {
          name: "异常导入卷", halls: [validHall], shows: [validShow], segments: [
            good("X-1"),
            good("X-1"),                                   // 完全重复编号
            good("x-1"),                                   // 仅大小写不同
            good(" X- 1 "),                                // 仅空格差异（去空格、忽略大小写后相同）
            good("   "),                                   // 空白编号
            good("X-2", { duration: -50 }),                // 非法时长
            good("X-3", { thumb: fakePng }),               // 伪装缩略图（字段应被清除，片段保留）
            good("X-4", { licenseStart: "2026-01-10", licenseEnd: "2026-01-01" }), // 授权起>止
            good("X-5", { licenseStart: "2026-02-30" }),   // 不存在的日历日期
            good("X-6")                                    // 正常
          ]
        },
        {
          name: "非法场次卷",
          halls: [{ id: "g1", name: "场次厅", aspect: "1.85", audio: "立体声", equipment: ["数字机"] }],
          shows: [
            { id: "g1s1", hallId: "g1", date: "2026-02-30", start: "14:00", end: "16:00" }, // 假日期
            { id: "g1s2", hallId: "g1", date: "2026-01-06", start: "25:70", end: "28:00" }, // 非法时刻
            { id: "g1s3", hallId: "g1", date: "2026-01-07", start: "10:00", end: "09:00" }  // 结束早于开始
          ],
          segments: [good("G-1")]
        }
      ]
    };
    await page.setInputFiles("#importFile", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) });
    await page.waitForSelector("#modalOverlay:not([hidden])");
    const txt = await modalText();
    check("导入预览列出拦截项", txt.includes("已拦截"));
    check("拦截完全重复编号", txt.includes("重复编号"));
    check("拦截仅大小写不同的编号", txt.includes("x-1") && txt.includes("忽略大小写"));
    check("拦截仅空格不同的编号", txt.includes("X- 1"));
    check("拦截空白编号", txt.includes("编号为空白"));
    check("拦截非法时长", txt.includes("时长非法"));
    check("拦截授权起>止", txt.includes("授权时段非法"));
    check("拦截不存在的授权日期 2026-02-30", txt.includes("不是真实日历日期"));
    check("拦截伪装缩略图", txt.includes("伪装缩略图"));
    check("拦截场次假日期", txt.includes("场次日期「2026-02-30」"));
    check("拦截非法时刻 25:70", txt.includes("25:70") && txt.includes("场次时刻非法"));
    check("拦截结束早于开始", txt.includes("结束不晚于开始"));
    // 预览仍列出有效卷（错误项被剔除但整卷仍可导入）
    check("预览仍可导入 1 个有效卷", txt.includes("确认导入 1 卷"));
    await page.click("#importConfirmBtn");
    await sleep(80);
    await closeModal();
    const { s } = await meta();
    const imp = s.reels.find((r) => r.name === "异常导入卷");
    // 有效：X-1、X-3、X-6（其余重复/空白/非法均被跳过）
    check("合法片段进入页面（X-1、X-3、X-6，共 3 段）", imp && imp.segments.length === 3, imp ? String(imp.segments.map((x) => x.code)) : "卷未导入");
    check("大小写/空格变体未混入", imp && imp.segments.every((x) => ["X-1", "X-3", "X-6"].includes(x.code)));
    check("空白编号未进入", imp && !imp.segments.some((x) => !x.code.trim()));
    const x3 = imp?.segments.find((x) => x.code === "X-3");
    check("X-3 伪装缩略图被清空", x3 && !x3.thumb);
    // 非法场次卷：所有场次被拒 → 整卷丢弃，绝不进入页面
    const badShowReel = s.reels.find((r) => r.name === "非法场次卷");
    check("无有效场次的卷整体不进入页面", !badShowReel);
  }

  /* ---------- 12b. 完全正常的导入（无异常，可预览并导入） ---------- */
  console.log("\n[12b] 正常导入");
  {
    const clean = {
      reels: [{
        name: "干净导入卷",
        halls: [{ id: "c1", name: "干净厅", aspect: "2.39", audio: "5.1环绕", equipment: ["数字机", "杜比处理器", "宽银幕镜头"] }],
        shows: [
          { id: "c1s1", hallId: "c1", date: "2026-03-01", start: "13:00", end: "15:30" },
          { id: "c1s2", hallId: "c1", date: "2026-02-28", start: "19:00", end: "21:00" } // 2026 非闰年，28 合法
        ],
        segments: [
          { code: "C-10", duration: 900, aspect: "2.39", audio: "5.1环绕", equipment: ["数字机", "杜比处理器"], licenseStart: "2026-02-01", licenseEnd: "2026-03-31" },
          { code: "C-20", duration: 720, aspect: "2.39", audio: "5.1环绕", equipment: ["宽银幕镜头"] }
        ]
      }]
    };
    await page.setInputFiles("#importFile", { name: "clean.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(clean)) });
    await page.waitForSelector("#modalOverlay:not([hidden])");
    const txt = await modalText();
    check("干净数据提示无异常", txt.includes("校验全部通过"));
    await page.click("#importConfirmBtn");
    await sleep(80);
    const { s } = await meta();
    const reel = s.reels.find((r) => r.name === "干净导入卷");
    check("干净卷 2 片段全部进入", reel && reel.segments.length === 2, String(reel?.segments.length));
    check("干净卷 2 场次全部进入", reel && reel.shows.length === 2, String(reel?.shows.length));
    check("合法闰年边界 2026-02-28 场次保留", reel && reel.shows.some((sh) => sh.date === "2026-02-28"));
  }

  /* ---------- 13. 导入畸形 JSON / 结构性异常，绝不进入页面 ---------- */
  console.log("\n[13] 畸形/结构异常导入");
  {
    const reelsBefore = (await meta()).s.reels.length;
    await page.setInputFiles("#importFile", { name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{not json") });
    await sleep(80);
    check("畸形 JSON 提示导入失败", (await modalText()).includes("不是合法 JSON"));
    await closeModal();
    await page.setInputFiles("#importFile", { name: "empty.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ reels: [] })) });
    await page.waitForSelector("#modalOverlay:not([hidden])");
    const txt = await modalText();
    check("空 reels 被拦截，异常不进入页面", txt.includes("异常数据未进入页面") || txt.includes("缺少 reels"));
    await closeModal();
    check("卷数量未因异常导入改变", (await meta()).s.reels.length === reelsBefore);
  }

  /* ---------- 14. 刷新恢复：数据 + 操作历史 ---------- */
  console.log("\n[14] 刷新恢复");
  const motherSnap = () => page.evaluate(() => {
    const s = window.__tourDesk.state();
    const mother = s.reels.find((r) => r.name === "华东巡演 · 母卷");
    const plan = s.plans.find((p) => p.reelId === mother.id);
    const showIds = new Set(mother.shows.map((x) => x.id));
    const placed = plan.placed.filter((p) => showIds.has(p.showId) && p.segmentId);
    return {
      reelCount: s.reels.length,
      motherSegs: mother.segments.length,
      motherPlaced: placed.length,
      motherLocked: placed.filter((p) => p.locked).length,
      past: window.__tourDesk.history().past.length
    };
  });
  {
    const pre = await motherSnap();
    await page.reload();
    await page.waitForSelector(".lib-card");
    const post = await motherSnap();
    check("刷新后母卷片段数保留", post.motherSegs === pre.motherSegs, `${pre.motherSegs}->${post.motherSegs}`);
    check("刷新后母卷已排数量保留", post.motherPlaced === pre.motherPlaced, `${pre.motherPlaced}->${post.motherPlaced}`);
    check("刷新后母卷锁定数量保留（含批量锁场）", post.motherLocked === pre.motherLocked, `${pre.motherLocked}->${post.motherLocked}`);
    check("刷新后导入的卷仍在", post.reelCount === pre.reelCount, `${pre.reelCount}->${post.reelCount}`);
    check("刷新后操作历史保留", post.past === pre.past, `${pre.past}->${post.past}`);
    check("刷新后无 JS 错误", errors.length === 0, errors.join(" | "));

    // 历史可用：撤销最近一次（导入），导入卷应消失
    await page.click("#undoBtn");
    await sleep(70);
    check("刷新后可撤销，回滚导入操作", (await meta()).s.reels.length === post.reelCount - 1);
  }

  /* ---------- 15. 复制为巡演版本 ---------- */
  console.log("\n[15] 复制为巡演版本");
  {
    // 撤销导入后当前卷可能已变，先切回母卷
    const motherId = await page.evaluate(() => window.__tourDesk.state().reels.find((r) => r.name === "华东巡演 · 母卷").id);
    await page.selectOption("#reelSelect", motherId);
    await sleep(50);
    const n0 = (await meta()).s.reels.length;
    await page.click("#copyTourBtn");
    await sleep(70);
    const { s, reel } = await meta();
    check("生成新巡演卷", s.reels.length === n0 + 1);
    check("新卷带巡演标记且独立", reel.tour === true && reel.name.includes("巡演副本"));
    check("复制卷片段数一致（9 段）", reel.segments.length === 9, String(reel.segments.length));
    check("复制卷默认无锁定排片", (await meta()).placed.filter((p) => p.locked).length === 0);
    const mother = s.reels.find((r) => r.name === "华东巡演 · 母卷");
    const motherIds = new Set(mother.segments.map((x) => x.id));
    check("复制卷片段为独立 ID", !reel.segments.some((x) => motherIds.has(x.id)));
  }

  await browser.close();

  console.log(`\n========== 结果：${passed} 通过，${failures.length} 失败 ==========`);
  if (failures.length) { failures.forEach((f) => console.error("FAIL:", f)); process.exit(1); }
  process.exit(0);
})().catch(async (e) => {
  console.error("测试脚本异常：", e);
  process.exit(1);
});
