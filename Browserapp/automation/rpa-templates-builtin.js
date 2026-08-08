'use strict';

/**
 * Built-in RPA templates for the local template store.
 *
 * This catalog provides:
 *  - 同类目 / 同类动作节点（gotoUrl / click / inputContent / forTimes …）
 *  - 可直接「使用 → 生成流程 → 运行」的完整 steps
 *  - 本地模板仓库全部免费可用
 *
 * Steps are self-contained CDP executable sequences.
 */

function S(type, params = {}, children) {
  const step = { type, ...params };
  if (children) step.children = children;
  return step;
}

const wait = (ms = 1000) => S('waitTime', { timeout: ms, timeoutType: 'fixed' });
const waitRand = (min = 400, max = 1200) => S('waitTime', {
  timeoutType: 'randomInterval', timeoutMin: min, timeoutMax: max,
});
const goto = (url) => S('gotoUrl', { url });
const click = (selector) => S('click', { selector, selectorRadio: 'CSS', button: 'left', type: 'click' });
const input = (selector, content, isClear = true) => S('inputContent', {
  selector, selectorRadio: 'CSS', content, isClear,
});
const key = (k) => S('keyboard', { key: k });
// `S` stores the action name in `type`, so motion style must use a distinct key.
const scroll = (deltaY = 600) => S('scrollPage', { deltaY, motion: 'smooth', rangeType: 'window' });
const waitSel = (selector, timeout = 12000) => S('waitForSelector', {
  selector, selectorRadio: 'CSS', timeout, isShow: true,
});
const js = (expression) => S('javaScript', { expression });
const newPage = (url) => S('newPage', { url });
const reload = () => S('refreshPage', {});
const shot = () => S('screenshotPage', { fullPage: true });
const getUrl = () => S('getUrl', {});
const clearCk = () => S('clearCookies', {});
const loop = (times, children) => S('forTimes', { times }, children);
// Store the evaluate result under a flow variable so later steps can reuse it.
const jsVar = (expression, variable) => S('javaScript', { expression, variable });
/**
 * Pure combiner: no DOM identifiers, so the engine runs it in the local sandbox.
 *
 * Must use the nested `params` form. A flat step would put the variable-name
 * array on `step.params`, and the engine's unwrapper — `step.params &&
 * typeof step.params === 'object' ? step.params : step` — treats an array as
 * the parameter object, losing `expression` entirely ("evaluate requires
 * expression"). Nesting keeps the names under `params.params` where the engine
 * looks for them.
 */
const jsJoin = (params, expression, variable) => ({
  type: 'javaScript',
  params: { params, expression, variable },
});
const getText = (selector, variable) => S('getElement', {
  selector, selectorRadio: 'CSS', type: 'innerText', variable,
});
// `content` names the variable holding the row array; fields pin the column order.
const exportCsv = (name, content, fields) => S('exportExcel', {
  name, content, ...(Array.isArray(fields) && fields.length ? { fields } : {}),
});
const saveTxt = (name, content) => S('saveData', { name, content });
const remark = (content) => S('saveRemark', { content });
const back = (timeout = 800) => S('goBack', { timeout });
// Overlay chrome differs per locale/site; `optional` lets the step skip instead of failing.
const clickMaybe = (selector) => S('click', {
  selector, selectorRadio: 'CSS', button: 'left', type: 'click', optional: true,
});
/**
 * Optional variants for skeleton templates.
 *
 * These flows ship pointing at example.com placeholders that the user is meant
 * to replace. Running one as-is used to throw on a selector the placeholder
 * page never had; `optional` makes the step skip with a log so the template
 * still demonstrates its shape end to end.
 */
const waitSelMaybe = (selector, timeout = 8000) => S('waitForSelector', {
  selector, selectorRadio: 'CSS', timeout, optional: true,
});
const inputMaybe = (selector, content, isClear = true) => S('inputContent', {
  selector, selectorRadio: 'CSS', content, isClear, optional: true,
});
const branch = (condition, relation, result, children, elseChildren) => {
  const step = S('ifElse', { condition, relation, result }, children);
  if (Array.isArray(elseChildren) && elseChildren.length) step.elseChildren = elseChildren;
  return step;
};

function tpl(partial) {
  return {
    uses: 0,
    builtin: true,
    source: 'builtin',
    pay_type: 1,
    developer: 'AiBrowser',
    tags: [],
    ...partial,
  };
}

/** @type {ReadonlyArray<object>} */
const BUILTIN_TEMPLATES = Object.freeze([
  // ─── 网页操作 ─────────────────────────────────────────
  tpl({
    id: 'builtin-baidu-search',
    name: '百度搜索关键词',
    cat: '网页操作',
    desc: '打开百度，输入关键词并点击搜索。适合快速了解流程结构。',
    tags: ['搜索', '百度', '入门'],
    uses: 1280,
    steps: [
      goto('https://www.baidu.com'),
      wait(1500),
      waitSel('#kw'),
      input('#kw', 'AiBrowser RPA'),
      wait(400),
      click('#su'),
      wait(2000),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-bing-search',
    name: 'Bing 搜索关键词',
    cat: '网页操作',
    desc: '打开 Bing，输入关键词并回车搜索。',
    tags: ['搜索', 'Bing'],
    uses: 860,
    steps: [
      goto('https://www.bing.com'),
      wait(1500),
      waitSel('#sb_form_q'),
      input('#sb_form_q', 'antidetect browser'),
      wait(300),
      key('Enter'),
      wait(2000),
    ],
  }),
  tpl({
    id: 'builtin-google-search',
    name: 'Google 搜索（需可访问）',
    cat: '网页操作',
    desc: '打开 Google 搜索页，输入关键词并提交。',
    tags: ['搜索', 'Google'],
    uses: 720,
    steps: [
      goto('https://www.google.com/ncr'),
      wait(1800),
      waitSel('textarea[name="q"], input[name="q"]', 15000),
      input('textarea[name="q"], input[name="q"]', 'open source fingerprint browser'),
      wait(300),
      key('Enter'),
      wait(2500),
    ],
  }),
  tpl({
    id: 'builtin-open-scroll',
    name: '打开网页并滚动浏览',
    cat: '网页操作',
    desc: '打开目标 URL，模拟真人向下滚动多次。养号常用骨架。',
    tags: ['滚动', '浏览', '养号'],
    uses: 2100,
    steps: [
      goto('https://example.com'),
      wait(1200),
      scroll(700),
      waitRand(500, 1100),
      scroll(700),
      waitRand(500, 1100),
      scroll(500),
      wait(800),
    ],
  }),
  tpl({
    id: 'builtin-multi-tab',
    name: '多标签打开站点',
    cat: '网页操作',
    desc: '当前页打开一个站点，再新建标签打开第二个。',
    tags: ['多标签'],
    uses: 540,
    steps: [
      goto('https://www.bing.com'),
      wait(800),
      newPage('https://www.wikipedia.org'),
      wait(1200),
    ],
  }),
  tpl({
    id: 'builtin-wait-click',
    name: '等待元素后点击',
    cat: '网页操作',
    desc: '打开页面，等待选择器出现后点击。可按目标站改 selector。',
    tags: ['等待', '点击'],
    uses: 980,
    steps: [
      goto('https://example.com'),
      waitSel('h1', 10000),
      click('h1'),
      wait(500),
    ],
  }),
  tpl({
    id: 'builtin-human-type',
    name: '拟人化输入搜索框',
    cat: '网页操作',
    desc: '带随机间隔的拟人输入（intervals），降低输入检测风险。',
    tags: ['拟人', '输入'],
    uses: 640,
    steps: [
      goto('https://www.bing.com'),
      wait(1200),
      waitSel('#sb_form_q'),
      S('inputContent', {
        selector: '#sb_form_q', selectorRadio: 'CSS', content: 'hello world',
        isClear: true, intervals: true, human: true, minDelay: 40, maxDelay: 140,
      }),
      wait(400),
      key('Enter'),
      wait(1800),
    ],
  }),
  tpl({
    id: 'builtin-page-nav-chain',
    name: '多页跳转链路',
    cat: '网页操作',
    desc: '依次打开多个 URL，中间随机等待，适合预热。',
    tags: ['预热', '跳转'],
    uses: 430,
    steps: [
      goto('https://example.com'),
      waitRand(800, 1600),
      goto('https://www.wikipedia.org'),
      waitRand(800, 1600),
      goto('https://www.bing.com'),
      wait(1000),
      getUrl(),
    ],
  }),

  // ─── 日常办公 ─────────────────────────────────────────
  tpl({
    id: 'builtin-daily-workspace-open',
    name: '每日工作台一键打开',
    cat: '日常办公',
    desc: '上班第一步：当前页打开主站，再用新标签依次打开常用工作台。把 URL 改成你自己的看板 / 邮箱 / 文档。',
    tags: ['办公', '多标签', '每日'],
    uses: 0,
    steps: [
      goto('https://mail.google.com'),
      wait(2000),
      newPage('https://calendar.google.com'),
      wait(1500),
      newPage('https://github.com/notifications'),
      wait(1500),
      newPage('https://www.notion.so'),
      wait(1500),
      remark('每日工作台已打开'),
    ],
  }),
  tpl({
    id: 'builtin-daily-checkin',
    name: '每日签到打卡（通用骨架）',
    cat: '日常办公',
    desc: '打开站点 → 关闭 Cookie 弹窗 → 点击签到按钮 → 截图存证。签到按钮 selector 请按站点修改。',
    tags: ['签到', '每日', '打卡'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(2000),
      clickMaybe('#onetrust-accept-btn-handler, .cookie-accept, [aria-label*="Accept"]'),
      wait(600),
      S('click', {
        selector: '#checkin, .sign-in-btn, button[class*="checkin"], a[href*="checkin"]',
        selectorRadio: 'CSS', button: 'left', type: 'click', optional: true,
      }),
      wait(2000),
      jsVar('(document.body.innerText || "").replace(/\\s+/g," ").trim().slice(0,200)', 'checkinText'),
      saveTxt('daily-checkin', '${checkinText}'),
      shot(),
    ],
  }),
  tpl({
    id: 'builtin-daily-archive-shots',
    name: '网页批量存档截图',
    cat: '日常办公',
    desc: '依次打开多个页面并逐页全屏截图，适合每日留档 / 汇报取证。改成你要归档的 URL。',
    tags: ['截图', '存档', '批量'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1800),
      shot(),
      goto('https://www.wikipedia.org'),
      wait(1800),
      shot(),
      goto('https://github.com/trending'),
      wait(2000),
      shot(),
      remark('批量存档截图完成'),
    ],
  }),
  tpl({
    id: 'builtin-daily-report-form',
    name: '日报表单填写提交（骨架）',
    cat: '日常办公',
    desc: '打开表单页 → 填标题与正文 → 提交 → 截图。务必把 URL 与 selector 换成你自己的表单。',
    tags: ['表单', '日报', '提交'],
    uses: 0,
    steps: [
      goto('https://example.com/form'),
      wait(2000),
      waitSelMaybe('input[name="title"], #title', 8000),
      inputMaybe('input[name="title"], #title', '工作日报'),
      wait(400),
      inputMaybe('textarea[name="content"], #content', '今日进展：\n1. \n2. \n明日计划：\n1. '),
      wait(400),
      S('click', {
        selector: 'button[type="submit"], input[type="submit"]',
        selectorRadio: 'CSS', button: 'left', type: 'click', optional: true,
      }),
      wait(2500),
      getUrl(),
      shot(),
    ],
  }),
  tpl({
    id: 'builtin-consent-dismiss',
    name: 'Cookie / 弹窗自动关闭',
    cat: '日常办公',
    desc: '打开页面后自动点掉常见 Cookie 同意条和弹窗遮罩，作为其他流程的前置片段复用。',
    tags: ['弹窗', 'Cookie', '前置'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1800),
      clickMaybe('#onetrust-accept-btn-handler'),
      clickMaybe('[id*="cookie"] button, [class*="cookie"] button[class*="accept"]'),
      clickMaybe('button[aria-label*="Close"], .modal-close, [class*="popup"] [class*="close"]'),
      wait(600),
      jsVar(`(() => {
        const blockers = Array.from(document.querySelectorAll('div,section'))
          .filter((el) => {
            const s = getComputedStyle(el);
            return s.position === 'fixed' && Number(s.zIndex || 0) > 999 && el.offsetHeight > 80;
          });
        return { remaining: blockers.length };
      })()`, 'overlayState'),
      remark('弹窗清理完成，剩余遮罩数见运行日志'),
    ],
  }),

  // ─── 养号浏览 ─────────────────────────────────────────
  tpl({
    id: 'builtin-nurture-scroll-loop',
    name: '循环滚动养号（5 次）',
    cat: '养号浏览',
    desc: '打开首页后 forTimes 循环滚动+随机等待，模拟停留。',
    tags: ['养号', '循环', '滚动'],
    uses: 1890,
    steps: [
      goto('https://example.com'),
      wait(1500),
      loop(5, [
        scroll(500),
        waitRand(600, 1400),
        scroll(400),
        waitRand(400, 900),
      ]),
    ],
  }),
  tpl({
    id: 'builtin-nurture-reload',
    name: '间歇刷新停留',
    cat: '养号浏览',
    desc: '打开页面后循环刷新，适合检测登录态保持。',
    tags: ['刷新', '养号'],
    uses: 410,
    steps: [
      goto('https://example.com'),
      wait(1000),
      loop(3, [reload(), waitRand(1500, 3000)]),
    ],
  }),
  tpl({
    id: 'builtin-nurture-read-page',
    name: '阅读页面并截图存证',
    cat: '养号浏览',
    desc: '进入页面、滚动阅读、截图记录（日志里留下截图长度）。',
    tags: ['截图', '阅读'],
    uses: 520,
    steps: [
      goto('https://example.com'),
      wait(1200),
      scroll(600),
      wait(1000),
      scroll(600),
      wait(800),
      shot(),
    ],
  }),

  // ─── 数据采集 ─────────────────────────────────────────
  tpl({
    id: 'builtin-get-title',
    name: '采集页面标题',
    cat: '数据采集',
    desc: '打开页面并用 JS 读取 document.title，写入运行日志。',
    tags: ['JS', '采集'],
    uses: 760,
    steps: [
      goto('https://example.com'),
      wait(1200),
      js('document.title'),
    ],
  }),
  tpl({
    id: 'builtin-get-url',
    name: '获取当前地址',
    cat: '数据采集',
    desc: '等待后读取当前页 URL。',
    tags: ['URL'],
    uses: 690,
    steps: [
      goto('https://example.com'),
      wait(800),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-extract-links',
    name: '采集页面外链列表',
    cat: '数据采集',
    desc: '用 JS 提取前 20 个 a[href]，适合目录页抓取骨架。',
    tags: ['链接', '采集'],
    uses: 880,
    steps: [
      goto('https://example.com'),
      wait(1500),
      js(`Array.from(document.querySelectorAll('a[href]')).slice(0,20).map(a=>({text:a.innerText.trim().slice(0,40),href:a.href}))`),
    ],
  }),
  tpl({
    id: 'builtin-extract-meta',
    name: '采集 meta 与 canonical',
    cat: '数据采集',
    desc: '读取 description / og:title / canonical 等 SEO 字段。',
    tags: ['meta', 'SEO'],
    uses: 390,
    steps: [
      goto('https://example.com'),
      wait(1000),
      js(`({
        title: document.title,
        desc: document.querySelector('meta[name="description"]')?.content || '',
        og: document.querySelector('meta[property="og:title"]')?.content || '',
        canonical: document.querySelector('link[rel="canonical"]')?.href || location.href
      })`),
    ],
  }),
  tpl({
    id: 'builtin-extract-text',
    name: '采集正文纯文本',
    cat: '数据采集',
    desc: '取 body.innerText 前 500 字，用于简单正文抓取。',
    tags: ['正文'],
    uses: 610,
    steps: [
      goto('https://example.com'),
      wait(1200),
      js(`(document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0,500)`),
    ],
  }),

  tpl({
    id: 'builtin-table-to-csv',
    name: '网页表格导出 CSV',
    cat: '数据采集',
    desc: '读取页面第一个 <table>，以表头为列名整理成行数据并导出 CSV 到 rpa-output 目录。',
    tags: ['表格', 'CSV', '导出'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1800),
      waitSelMaybe('table', 8000),
      jsVar(`(() => {
        const table = document.querySelector('table');
        if (!table) return [];
        const rows = Array.from(table.querySelectorAll('tr'));
        if (!rows.length) return [];
        const head = Array.from(rows[0].querySelectorAll('th,td'))
          .map((cell, i) => (cell.innerText || '').trim() || ('col' + (i + 1)));
        return rows.slice(1, 201).map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => (c.innerText || '').trim());
          return Object.fromEntries(cells.map((v, i) => [head[i] || ('col' + (i + 1)), v]));
        });
      })()`, 'tableRows'),
      exportCsv('table-export', 'tableRows'),
      remark('表格已导出到 rpa-output 目录'),
    ],
  }),
  tpl({
    id: 'builtin-scroll-load-collect',
    name: '滚动加载并采集列表',
    cat: '数据采集',
    desc: '瀑布流 / 无限滚动页面：循环滚动触发懒加载，最后一次性采集卡片标题与链接并导出 CSV。',
    tags: ['滚动', '懒加载', 'CSV'],
    uses: 0,
    steps: [
      goto('https://github.com/trending'),
      wait(2200),
      loop(5, [
        scroll(1200),
        waitRand(800, 1600),
      ]),
      jsVar(`(() => {
        const seen = new Set();
        return Array.from(document.querySelectorAll('article h2 a, .list-item a, li a[href]'))
          .map((a) => ({ title: (a.innerText || '').trim().slice(0, 120), href: a.href }))
          .filter((row) => row.title && row.href && !seen.has(row.href) && seen.add(row.href))
          .slice(0, 200);
      })()`, 'listRows'),
      exportCsv('scroll-list', 'listRows', ['title', 'href']),
    ],
  }),
  tpl({
    id: 'builtin-paging-next-collect',
    name: '翻页采集（点击下一页 3 轮）',
    cat: '数据采集',
    desc: '每页把结果累积进 sessionStorage 再点“下一页”，翻完统一导出 CSV。下一页 selector 按站点修改。',
    tags: ['翻页', '采集', 'CSV'],
    uses: 0,
    steps: [
      goto('https://example.com/list'),
      wait(2000),
      js('sessionStorage.removeItem("__obRows")'),
      loop(3, [
        wait(1500),
        js(`(() => {
          const acc = JSON.parse(sessionStorage.getItem('__obRows') || '[]');
          const rows = Array.from(document.querySelectorAll('a[href]'))
            .map((a) => ({ title: (a.innerText || '').trim().slice(0, 120), href: a.href }))
            .filter((row) => row.title);
          sessionStorage.setItem('__obRows', JSON.stringify(acc.concat(rows).slice(0, 500)));
          return acc.length + rows.length;
        })()`),
        S('click', {
          selector: 'a[rel="next"], .next, .pagination-next, a[aria-label*="Next"]',
          selectorRadio: 'CSS', button: 'left', type: 'click', optional: true,
        }),
        waitRand(1500, 2500),
      ]),
      jsVar('JSON.parse(sessionStorage.getItem("__obRows") || "[]")', 'pagedRows'),
      exportCsv('paged-list', 'pagedRows', ['title', 'href']),
    ],
  }),
  tpl({
    id: 'builtin-serp-collect-csv',
    name: '搜索结果榜单采集导出',
    cat: '数据采集',
    desc: '在 Bing 搜索关键词，把结果标题、链接和摘要整理成 CSV。改 content 即可换关键词。',
    tags: ['搜索', '榜单', 'CSV'],
    uses: 0,
    steps: [
      goto('https://www.bing.com'),
      wait(1800),
      waitSel('#sb_form_q'),
      input('#sb_form_q', 'fingerprint browser'),
      wait(400),
      key('Enter'),
      wait(2800),
      jsVar(`(() => Array.from(document.querySelectorAll('#b_results > li.b_algo')).slice(0, 30).map((li, i) => ({
        rank: i + 1,
        title: (li.querySelector('h2')?.innerText || '').trim(),
        href: li.querySelector('h2 a')?.href || '',
        snippet: (li.querySelector('.b_caption p')?.innerText || '').trim().slice(0, 200)
      })).filter((row) => row.title))()`, 'serpRows'),
      exportCsv('serp-results', 'serpRows', ['rank', 'title', 'href', 'snippet']),
    ],
  }),
  tpl({
    id: 'builtin-price-watch-log',
    name: '商品价格监控记录',
    cat: '数据采集',
    desc: '打开商品页读取价格与标题，带时间戳追加写入本地 txt，可配合计划任务做每日盯价。',
    tags: ['价格', '监控', '计划任务'],
    uses: 0,
    steps: [
      goto('https://example.com/product'),
      wait(2200),
      jsVar(`(() => {
        const pick = (list) => {
          for (const sel of list) {
            const el = document.querySelector(sel);
            const text = (el?.innerText || '').trim();
            if (text) return text;
          }
          return '';
        };
        return {
          title: pick(['h1', '#productTitle', '[class*="title"]']).slice(0, 120),
          price: pick(['.a-price .a-offscreen', '[class*="price"]', '[itemprop="price"]']).slice(0, 40),
          time: new Date().toISOString(),
          url: location.href
        };
      })()`, 'priceRow'),
      // CSV is rewritten each run; the txt line is appended so history accumulates.
      jsJoin(['priceRow'], 'return JSON.stringify(priceRow)', 'priceLine'),
      saveTxt('price-watch', '${priceLine}'),
      exportCsv('price-watch', 'priceRow', ['time', 'title', 'price', 'url']),
    ],
  }),
  tpl({
    id: 'builtin-collect-images',
    name: '采集页面图片地址',
    cat: '数据采集',
    desc: '提取页面所有 img 的地址与 alt 文案并导出 CSV，适合素材整理。',
    tags: ['图片', '素材', 'CSV'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1500),
      scroll(900),
      wait(900),
      jsVar(`(() => {
        const seen = new Set();
        return Array.from(document.images)
          .map((img) => ({ src: img.currentSrc || img.src, alt: (img.alt || '').slice(0, 100), w: img.naturalWidth, h: img.naturalHeight }))
          .filter((row) => row.src && !seen.has(row.src) && seen.add(row.src))
          .slice(0, 200);
      })()`, 'imageRows'),
      exportCsv('page-images', 'imageRows', ['src', 'alt', 'w', 'h']),
    ],
  }),

  // ─── 社交媒体 ─────────────────────────────────────────
  tpl({
    id: 'builtin-x-open-home',
    name: '打开 X/Twitter 首页浏览',
    cat: '社交媒体',
    desc: '打开 x.com，等待主栏，滚动时间线。登录态依赖当前环境 Cookie。',
    tags: ['X', 'Twitter', '滚动'],
    uses: 1450,
    steps: [
      goto('https://x.com'),
      wait(2500),
      scroll(800),
      waitRand(800, 1600),
      scroll(800),
      wait(1000),
    ],
  }),
  tpl({
    id: 'builtin-reddit-browse',
    name: 'Reddit 热门浏览',
    cat: '社交媒体',
    desc: '打开 Reddit 热门并滚动。',
    tags: ['Reddit'],
    uses: 670,
    steps: [
      goto('https://www.reddit.com/r/popular/'),
      wait(2200),
      scroll(900),
      waitRand(700, 1500),
      scroll(900),
    ],
  }),
  tpl({
    id: 'builtin-youtube-home',
    name: 'YouTube 首页滚动',
    cat: '社交媒体',
    desc: '打开 YouTube 首页并向下浏览推荐。',
    tags: ['YouTube'],
    uses: 910,
    steps: [
      goto('https://www.youtube.com'),
      wait(2500),
      scroll(1000),
      wait(1200),
      scroll(1000),
    ],
  }),
  tpl({
    id: 'builtin-github-trending',
    name: 'GitHub Trending 浏览',
    cat: '社交媒体',
    desc: '打开 GitHub Trending，采集仓库名列表。',
    tags: ['GitHub', '采集'],
    uses: 480,
    steps: [
      goto('https://github.com/trending'),
      wait(2000),
      js(`Array.from(document.querySelectorAll('article h2 a')).slice(0,10).map(a=>a.innerText.trim())`),
      scroll(600),
    ],
  }),

  tpl({
    id: 'builtin-social-daily-round',
    name: '社媒每日巡检轮转',
    cat: '社交媒体',
    desc: '依次走一遍 X / Reddit / YouTube，每站滚动停留并截图，适合多账号日常保活。',
    tags: ['社媒', '每日', '轮转'],
    uses: 0,
    steps: [
      goto('https://x.com/home'),
      wait(3000),
      scroll(900),
      waitRand(900, 1800),
      scroll(900),
      shot(),
      goto('https://www.reddit.com/r/popular/'),
      wait(2500),
      scroll(1000),
      waitRand(900, 1800),
      shot(),
      goto('https://www.youtube.com'),
      wait(2500),
      scroll(1000),
      waitRand(800, 1500),
      shot(),
      remark('社媒每日巡检完成'),
    ],
  }),
  tpl({
    id: 'builtin-youtube-search-watch',
    name: 'YouTube 搜索并观看',
    cat: '社交媒体',
    desc: '搜索关键词 → 打开第一个视频 → 停留观看一段时间。改 content 换关键词。',
    tags: ['YouTube', '搜索', '观看'],
    uses: 0,
    steps: [
      goto('https://www.youtube.com'),
      wait(2800),
      clickMaybe('button[aria-label*="Accept"], button[aria-label*="接受"]'),
      waitSel('input#search, input[name="search_query"]', 15000),
      input('input#search, input[name="search_query"]', 'browser automation'),
      wait(600),
      key('Enter'),
      wait(3000),
      S('click', {
        selector: 'ytd-video-renderer a#video-title, a#video-title-link',
        selectorRadio: 'CSS', button: 'left', type: 'click', optional: true,
      }),
      wait(4000),
      waitRand(8000, 15000),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-social-profile-collect',
    name: '社媒主页数据采集',
    cat: '社交媒体',
    desc: '打开公开主页，抓取标题、简介与关注/粉丝等可见数字并导出 CSV。',
    tags: ['主页', '采集', 'CSV'],
    uses: 0,
    steps: [
      goto('https://github.com/torvalds'),
      wait(2500),
      jsVar(`(() => {
        const nums = Array.from(document.querySelectorAll('a,span'))
          .map((el) => (el.innerText || '').trim())
          .filter((text) => /^[\\d.,km]+\\s*(followers|following|stars|关注|粉丝)$/i.test(text))
          .slice(0, 6);
        return {
          url: location.href,
          title: document.title.slice(0, 120),
          bio: (document.querySelector('[class*="bio"], [data-bio], meta[name="description"]')?.innerText
            || document.querySelector('meta[name="description"]')?.content || '').trim().slice(0, 200),
          metrics: nums.join(' | '),
          time: new Date().toISOString()
        };
      })()`, 'profileRow'),
      exportCsv('social-profile', 'profileRow', ['time', 'url', 'title', 'bio', 'metrics']),
    ],
  }),

  // ─── 电商 ─────────────────────────────────────────────
  tpl({
    id: 'builtin-amazon-search',
    name: 'Amazon 商品搜索',
    cat: '电商',
    desc: '打开 Amazon 搜索框输入关键词（站点可按地区改域名）。',
    tags: ['Amazon', '搜索'],
    uses: 1020,
    steps: [
      goto('https://www.amazon.com'),
      wait(2000),
      waitSel('#twotabsearchtextbox', 15000),
      input('#twotabsearchtextbox', 'wireless mouse'),
      wait(400),
      click('#nav-search-submit-button'),
      wait(2500),
      scroll(700),
    ],
  }),
  tpl({
    id: 'builtin-ebay-search',
    name: 'eBay 商品搜索',
    cat: '电商',
    desc: '打开 eBay 搜索并滚动结果。',
    tags: ['eBay'],
    uses: 430,
    steps: [
      goto('https://www.ebay.com'),
      wait(1800),
      waitSel('#gh-ac', 12000),
      input('#gh-ac', 'mechanical keyboard'),
      wait(300),
      key('Enter'),
      wait(2200),
      scroll(600),
    ],
  }),
  tpl({
    id: 'builtin-product-watch',
    name: '商品页停留与截图',
    cat: '电商',
    desc: '打开指定商品页 URL，滚动细节并截图。请把 URL 改成你的商品。',
    tags: ['商品', '截图'],
    uses: 560,
    steps: [
      goto('https://example.com'),
      wait(1500),
      scroll(500),
      wait(800),
      scroll(500),
      shot(),
      js('document.title'),
    ],
  }),

  tpl({
    id: 'builtin-cart-order-check',
    name: '购物车 / 订单页巡检',
    cat: '电商',
    desc: '打开购物车页读取条目数与合计金额，截图并写入本地记录。只读不下单。',
    tags: ['购物车', '巡检', '截图'],
    uses: 0,
    steps: [
      goto('https://www.amazon.com/gp/cart/view.html'),
      wait(2800),
      clickMaybe('#sp-cc-accept'),
      jsVar(`(() => {
        const text = (sel) => (document.querySelector(sel)?.innerText || '').trim();
        return {
          items: document.querySelectorAll('[data-name="Active Items"] .sc-list-item, .cart-item, [class*="cart"] li').length,
          subtotal: text('#sc-subtotal-amount-activecart, [class*="subtotal"]').slice(0, 40),
          url: location.href,
          time: new Date().toISOString()
        };
      })()`, 'cartState'),
      jsJoin(['cartState'], 'return JSON.stringify(cartState)', 'cartLine'),
      saveTxt('cart-check', '${cartLine}'),
      shot(),
    ],
  }),
  tpl({
    id: 'builtin-stock-availability-check',
    name: '商品库存 / 到货状态检查',
    cat: '电商',
    desc: '读取商品页库存文案，按关键词判断是否有货，分别写入不同备注。改 URL 与关键词即可。',
    tags: ['库存', '条件', '监控'],
    uses: 0,
    steps: [
      goto('https://example.com/product'),
      wait(2200),
      jsVar(`(() => ((document.querySelector('#availability, [class*="stock"], [class*="availability"]')?.innerText) || document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200))()`, 'stockText'),
      branch('stockText', 'contain', 'In Stock', [
        remark('有货：${stockText}'),
        saveTxt('stock-in', '${stockText}'),
        shot(),
      ], [
        remark('暂无货或文案不匹配：${stockText}'),
        saveTxt('stock-out', '${stockText}'),
      ]),
    ],
  }),

  // ─── 账号管理 ─────────────────────────────────────────
  tpl({
    id: 'builtin-clear-cookies',
    name: '清 Cookie 后刷新',
    cat: '账号管理',
    desc: '清除浏览器 Cookie 并刷新当前页。',
    tags: ['Cookie', '清理'],
    uses: 1180,
    steps: [
      clearCk(),
      wait(300),
      reload(),
      wait(800),
    ],
  }),
  tpl({
    id: 'builtin-cookie-check',
    name: '检查 Cookie 数量',
    cat: '账号管理',
    desc: '用 JS 读取 document.cookie 片段，确认登录态是否还在。',
    tags: ['Cookie', '检查'],
    uses: 740,
    steps: [
      goto('https://example.com'),
      wait(800),
      js(`({ cookieLen: (document.cookie||'').length, sample: (document.cookie||'').slice(0,120) })`),
    ],
  }),
  tpl({
    id: 'builtin-login-form-fill',
    name: '通用登录表单填充（改 selector）',
    cat: '账号管理',
    desc: '骨架：打开登录页 → 填用户名/密码 → 点击登录。务必改 URL 与 selector。',
    tags: ['登录', '表单'],
    uses: 1560,
    steps: [
      goto('https://example.com'),
      wait(1500),
      inputMaybe('input[type="email"], input[name="username"], input[name="email"], #email', 'demo@example.com'),
      wait(400),
      inputMaybe('input[type="password"], input[name="password"], #password', 'ChangeMe123!'),
      wait(400),
      clickMaybe('button[type="submit"], input[type="submit"], .login-btn, #login'),
      wait(2500),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-logout-clear',
    name: '退出态清理（清 Cookie+跳转）',
    cat: '账号管理',
    desc: '清理 Cookie 后跳转到首页，模拟干净会话。',
    tags: ['退出', '清理'],
    uses: 390,
    steps: [
      clearCk(),
      wait(300),
      goto('https://example.com'),
      wait(1000),
    ],
  }),

  tpl({
    id: 'builtin-login-state-audit',
    name: '多站点登录态巡检',
    cat: '账号管理',
    desc: '依次访问多个站点判断是否仍处于登录态，汇总成一份 CSV。适合批量环境每天跑一次。',
    tags: ['登录态', '巡检', 'CSV'],
    uses: 0,
    steps: [
      goto('https://github.com'),
      wait(2500),
      jsVar(`(() => ({
        site: 'github',
        url: location.href,
        loggedIn: document.querySelector('meta[name="user-login"][content]:not([content=""]), summary[aria-label*="user"]') ? 'yes' : 'no',
        cookieLen: (document.cookie || '').length,
        time: new Date().toISOString()
      }))()`, 'siteA'),
      goto('https://www.reddit.com'),
      wait(2500),
      jsVar(`(() => ({
        site: 'reddit',
        url: location.href,
        loggedIn: /logout|my profile|u\\//i.test(document.body.innerText || '') ? 'yes' : 'no',
        cookieLen: (document.cookie || '').length,
        time: new Date().toISOString()
      }))()`, 'siteB'),
      goto('https://x.com/home'),
      wait(3000),
      jsVar(`(() => ({
        site: 'x',
        url: location.href,
        loggedIn: /\\/home/.test(location.pathname) && !/login|i\\/flow/.test(location.pathname) ? 'yes' : 'no',
        cookieLen: (document.cookie || '').length,
        time: new Date().toISOString()
      }))()`, 'siteC'),
      jsJoin(['siteA', 'siteB', 'siteC'], 'return [siteA, siteB, siteC].filter(Boolean)', 'auditRows'),
      exportCsv('login-state-audit', 'auditRows', ['time', 'site', 'loggedIn', 'cookieLen', 'url']),
    ],
  }),
  tpl({
    id: 'builtin-session-keepalive',
    name: '会话保活轮询',
    cat: '账号管理',
    desc: '循环刷新并轻微滚动关键页面，保持登录会话不过期。配合计划任务定时跑效果更好。',
    tags: ['保活', '会话', '计划任务'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(2000),
      loop(6, [
        reload(),
        waitRand(2000, 4000),
        scroll(500),
        waitRand(1500, 3000),
      ]),
      jsVar('({ cookieLen: (document.cookie || "").length, url: location.href })', 'keepaliveState'),
      remark('会话保活轮询结束'),
    ],
  }),
  tpl({
    id: 'builtin-cookie-snapshot',
    name: 'Cookie 快照存档',
    cat: '账号管理',
    desc: '记录当前环境可见 Cookie 的名称清单与数量（不含取值），便于对比登录态变化。',
    tags: ['Cookie', '快照', '存档'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1500),
      jsVar(`(() => {
        const names = (document.cookie || '').split(';').map((item) => item.split('=')[0].trim()).filter(Boolean);
        return { host: location.host, count: names.length, names: names.join(' '), time: new Date().toISOString() };
      })()`, 'cookieSnapshot'),
      exportCsv('cookie-snapshot', 'cookieSnapshot', ['time', 'host', 'count', 'names']),
    ],
  }),

  // ─── 工具 ─────────────────────────────────────────────
  tpl({
    id: 'builtin-screenshot',
    name: '打开页面并截图',
    cat: '工具',
    desc: '导航到目标页，等待加载后截图（记录在运行日志）。',
    tags: ['截图'],
    uses: 920,
    steps: [
      goto('https://example.com'),
      wait(1500),
      shot(),
    ],
  }),
  tpl({
    id: 'builtin-ua-probe',
    name: '环境指纹探针',
    cat: '工具',
    desc: '读取 UA / 语言 / 时区 / 屏幕，用于核对环境是否符合预期。',
    tags: ['指纹', '探针'],
    uses: 1340,
    steps: [
      goto('https://example.com'),
      wait(800),
      js(`({
        ua: navigator.userAgent,
        lang: navigator.language,
        langs: navigator.languages,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
        platform: navigator.platform,
        hw: navigator.hardwareConcurrency,
        mem: navigator.deviceMemory || null
      })`),
    ],
  }),
  tpl({
    id: 'builtin-ip-check',
    name: '出口 IP 检测（ipify）',
    cat: '工具',
    desc: '打开 ipify 纯文本接口页面读取出口 IP。',
    tags: ['IP', '代理'],
    uses: 1710,
    steps: [
      goto('https://api.ipify.org?format=json'),
      wait(1500),
      js(`document.body.innerText`),
    ],
  }),
  tpl({
    id: 'builtin-timezone-check',
    name: '时区与本地时间',
    cat: '工具',
    desc: '核对时区与本地时间字符串。',
    tags: ['时区'],
    uses: 450,
    steps: [
      goto('about:blank'),
      wait(300),
      js(`({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date().toString(), offset: new Date().getTimezoneOffset() })`),
    ],
  }),
  tpl({
    id: 'builtin-webgl-probe',
    name: 'WebGL 渲染器探针',
    cat: '工具',
    desc: '读取 WebGL UNMASKED_VENDOR/RENDERER，检查 GPU 伪装。',
    tags: ['WebGL', '指纹'],
    uses: 990,
    steps: [
      goto('about:blank'),
      wait(300),
      js(`(() => {
        try {
          const c = document.createElement('canvas');
          const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
          if (!gl) return { ok: false };
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return {
            ok: true,
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
          };
        } catch (e) { return { ok: false, err: String(e) }; }
      })()`),
    ],
  }),

  tpl({
    id: 'builtin-env-consistency-report',
    name: '环境一致性核验报告',
    cat: '工具',
    desc: '一次跑完出口 IP、时区、语言、UA、WebGL 核验，汇总成一份 CSV。换代理后先跑这个。',
    tags: ['指纹', '代理', '核验', 'CSV'],
    uses: 0,
    steps: [
      goto('https://api.ipify.org?format=json'),
      wait(2000),
      jsVar(`(() => {
        try { return JSON.parse(document.body.innerText || '{}').ip || ''; } catch (e) { return ''; }
      })()`, 'exitIp'),
      goto('about:blank'),
      wait(400),
      jsVar(`(() => {
        let webgl = '';
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
          webgl = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
        } catch (e) { webgl = ''; }
        return {
          ua: navigator.userAgent,
          platform: navigator.platform,
          lang: navigator.language,
          langs: (navigator.languages || []).join(','),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offset: new Date().getTimezoneOffset(),
          screen: screen.width + 'x' + screen.height + '@' + devicePixelRatio,
          cores: navigator.hardwareConcurrency || 0,
          webgl: webgl.slice(0, 80)
        };
      })()`, 'envInfo'),
      jsJoin(['exitIp', 'envInfo'], 'return [Object.assign({ exitIp: exitIp, time: new Date().toISOString() }, envInfo || {})]', 'envRows'),
      exportCsv('env-consistency', 'envRows', ['time', 'exitIp', 'tz', 'offset', 'lang', 'langs', 'platform', 'screen', 'cores', 'webgl', 'ua']),
      remark('环境核验报告已导出，请比对代理归属地与时区/语言是否一致'),
    ],
  }),
  tpl({
    id: 'builtin-page-perf-collect',
    name: '页面加载性能采集',
    cat: '工具',
    desc: '读取 Navigation Timing 的 DNS / TCP / 首字节 / DOM / 总耗时，导出 CSV 便于对比不同代理。',
    tags: ['性能', '耗时', 'CSV'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(2500),
      jsVar(`(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        if (!nav) return [];
        const ms = (value) => Math.round(Number(value) || 0);
        return [{
          time: new Date().toISOString(),
          url: location.href,
          dns: ms(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: ms(nav.connectEnd - nav.connectStart),
          ttfb: ms(nav.responseStart - nav.requestStart),
          download: ms(nav.responseEnd - nav.responseStart),
          dom: ms(nav.domContentLoadedEventEnd - nav.startTime),
          total: ms(nav.loadEventEnd - nav.startTime)
        }];
      })()`, 'perfRows'),
      exportCsv('page-perf', 'perfRows', ['time', 'url', 'dns', 'tcp', 'ttfb', 'download', 'dom', 'total']),
    ],
  }),
  tpl({
    id: 'builtin-broken-link-scan',
    name: '页面死链扫描',
    cat: '工具',
    desc: '取页面前 25 条外链逐个探测可达性，导出结果 CSV。受同源策略限制，跨域结果多为 opaque。',
    tags: ['死链', '巡检', 'CSV'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1800),
      jsVar(`(async () => {
        const links = [...new Set(Array.from(document.querySelectorAll('a[href^="http"]')).map((a) => a.href))].slice(0, 25);
        const rows = [];
        for (const href of links) {
          try {
            const response = await fetch(href, { method: 'HEAD', mode: 'no-cors' });
            rows.push({ href: href, status: response.status || 0, result: response.type === 'opaque' ? 'opaque' : (response.ok ? 'ok' : 'bad') });
          } catch (error) {
            rows.push({ href: href, status: 0, result: 'error' });
          }
        }
        return rows;
      })()`, 'linkRows'),
      exportCsv('broken-links', 'linkRows', ['href', 'status', 'result']),
    ],
  }),
  tpl({
    id: 'builtin-page-health-check',
    name: '网页可用性健康检查',
    cat: '工具',
    desc: '检查页面标题、状态文案、控制台可见错误与关键元素是否存在，判定站点是否正常。',
    tags: ['健康检查', '巡检', '条件'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(2000),
      jsVar(`(() => {
        const text = (document.body.innerText || '').slice(0, 400);
        const bad = /(404|not found|503|502|service unavailable|出错了|访问异常)/i.test(text) || /404|error/i.test(document.title);
        return bad ? 'down' : 'up';
      })()`, 'healthState'),
      branch('healthState', 'equal', 'up', [
        remark('站点正常：${healthState}'),
        saveTxt('health-up', '${healthState}'),
      ], [
        remark('站点异常，请人工确认：${healthState}'),
        saveTxt('health-down', '${healthState}'),
        shot(),
      ]),
    ],
  }),
  tpl({
    id: 'builtin-page-text-archive',
    name: '正文提取并存档',
    cat: '工具',
    desc: '提取标题与正文纯文本写入本地 txt，适合资料留存与后续检索。',
    tags: ['正文', '存档', '文本'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1800),
      jsVar(`(() => {
        const main = document.querySelector('article, main, [role="main"]') || document.body;
        return '# ' + document.title + '\\n' + location.href + '\\n\\n'
          + (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000);
      })()`, 'articleText'),
      saveTxt('page-archive', '${articleText}'),
      remark('正文已存档到 rpa-output 目录'),
    ],
  }),

  // ─── 流程控制 ─────────────────────────────────────────
  tpl({
    id: 'builtin-loop-refresh',
    name: '循环刷新 3 次',
    cat: '流程控制',
    desc: 'forTimes 循环刷新当前页。',
    tags: ['循环', '刷新'],
    uses: 580,
    steps: [
      goto('https://example.com'),
      wait(600),
      loop(3, [reload(), wait(800)]),
    ],
  }),
  tpl({
    id: 'builtin-nested-loop-browse',
    name: '嵌套：打开→循环滚动',
    cat: '流程控制',
    desc: '演示 forTimes 嵌套滚动步骤。',
    tags: ['循环', '嵌套'],
    uses: 360,
    steps: [
      goto('https://example.com'),
      wait(1000),
      loop(2, [
        loop(2, [scroll(400), waitRand(300, 700)]),
        wait(500),
      ]),
    ],
  }),
  tpl({
    id: 'builtin-key-combo-demo',
    name: '键盘操作演示（Ctrl/Meta+A 选中）',
    cat: '流程控制',
    desc: '聚焦 body 后发送组合键（平台差异请自测）。',
    tags: ['键盘'],
    uses: 220,
    steps: [
      goto('https://example.com'),
      wait(800),
      js('document.body.focus()'),
      key('a'),
      wait(500),
    ],
  }),

  tpl({
    id: 'builtin-ifelse-login-branch',
    name: '条件分支：登录态判断',
    cat: '流程控制',
    desc: 'ifElse 用法示范：检测到登录态就继续业务动作，未登录则跳转登录页并截图提醒。',
    tags: ['条件', 'ifElse', '登录'],
    uses: 0,
    steps: [
      goto('https://github.com'),
      wait(2500),
      jsVar(`(() => (document.querySelector('meta[name="user-login"][content]:not([content=""])') ? 'yes' : 'no'))()`, 'isLoggedIn'),
      branch('isLoggedIn', 'equal', 'yes', [
        remark('已登录，执行后续业务动作'),
        scroll(600),
        wait(800),
        shot(),
      ], [
        remark('未登录，跳转登录页等待人工处理'),
        goto('https://github.com/login'),
        wait(2000),
        shot(),
      ]),
    ],
  }),
  tpl({
    id: 'builtin-retry-navigation',
    name: '加载失败重试（3 轮）',
    cat: '流程控制',
    desc: '打开页面后循环判断是否加载成功，失败则刷新重试，适合代理不稳时兜底。',
    tags: ['重试', '循环', '稳定性'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(2000),
      loop(3, [
        jsVar(`(() => (document.readyState === 'complete' && (document.body.innerText || '').trim().length > 40 ? 'ok' : 'retry'))()`, 'loadState'),
        branch('loadState', 'equal', 'retry', [
          remark('页面未就绪，刷新重试'),
          reload(),
          waitRand(2000, 4000),
        ], [
          remark('页面已就绪'),
          wait(300),
        ]),
      ]),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-multi-tab-switch',
    name: '多标签切换与返回',
    cat: '流程控制',
    desc: '演示 newPage / switchPage / goBack：开两个标签，切回第一个再执行后退。',
    tags: ['标签页', '切换', '后退'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1200),
      newPage('https://www.wikipedia.org'),
      wait(1800),
      S('switchPage', { content: 'example.com', relation: 'contain' }),
      wait(1000),
      goto('https://www.bing.com'),
      wait(1500),
      back(1200),
      getUrl(),
    ],
  }),
  tpl({
    id: 'builtin-regex-extract-branch',
    name: '正则提取并判断',
    cat: '流程控制',
    desc: 'extractData 正则取值 + ifElse 判断的组合示范：从正文里抽取第一个数字再分支处理。',
    tags: ['正则', '提取', '条件'],
    uses: 0,
    steps: [
      goto('https://example.com'),
      wait(1500),
      jsVar('(document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 500)', 'pageText'),
      S('extractData', {
        content: 'pageText', reg: '(\\d+)', variable: 'firstNumber', onlyGetFirst: true,
      }),
      branch('firstNumber', 'exist', '', [
        remark('提取到数字：${firstNumber}'),
        saveTxt('regex-extract', '${firstNumber}'),
      ], [
        remark('页面中没有匹配到数字'),
      ]),
    ],
  }),

  // ─── 邮箱 / 验证 ───────────────────────────────────────
  tpl({
    id: 'builtin-open-webmail',
    name: '打开网页邮箱入口',
    cat: '邮箱验证',
    desc: '打开常见网页邮箱登录页（Gmail）。需环境可访问。',
    tags: ['邮箱', 'Gmail'],
    uses: 640,
    steps: [
      goto('https://mail.google.com'),
      wait(2500),
      getUrl(),
      shot(),
    ],
  }),
  tpl({
    id: 'builtin-outlook-open',
    name: '打开 Outlook 网页版',
    cat: '邮箱验证',
    desc: '打开 Outlook 登录/收件箱入口。',
    tags: ['邮箱', 'Outlook'],
    uses: 410,
    steps: [
      goto('https://outlook.live.com/mail/'),
      wait(2500),
      getUrl(),
    ],
  }),

  // ─── 开发调试 ─────────────────────────────────────────
  tpl({
    id: 'builtin-blank-ready',
    name: '空白页就绪检查',
    cat: '开发调试',
    desc: 'about:blank 探针，验证 RPA/CDP 链路是否通。',
    tags: ['调试', 'CDP'],
    uses: 300,
    steps: [
      goto('about:blank'),
      wait(200),
      js('({ ready: document.readyState, href: location.href })'),
    ],
  }),
  tpl({
    id: 'builtin-console-echo',
    name: 'JS 表达式回显',
    cat: '开发调试',
    desc: '执行 1+1 与 JSON 回显，验证 evaluate 通路。',
    tags: ['调试', 'JS'],
    uses: 250,
    steps: [
      goto('about:blank'),
      js('1+1'),
      js('JSON.stringify({ok:true,ts:Date.now()})'),
    ],
  }),
  tpl({
    id: 'builtin-selector-stress',
    name: '选择器等待压力测试',
    cat: '开发调试',
    desc: '等待 h1，再读 textContent。',
    tags: ['选择器'],
    uses: 180,
    steps: [
      goto('https://example.com'),
      waitSel('h1'),
      js('document.querySelector("h1")?.textContent'),
    ],
  }),
]);

function cloneBuiltinTemplates() {
  return BUILTIN_TEMPLATES.map((item) => ({
    ...item,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    steps: JSON.parse(JSON.stringify(item.steps || [])),
  }));
}

module.exports = {
  BUILTIN_TEMPLATES,
  cloneBuiltinTemplates,
};
