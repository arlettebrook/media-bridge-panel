'use strict';
/**
 * 面板模块 · 「设置」页：面板自己那些**要动手改的参数**。
 *
 *   · 站点测速       **开关与间隔**（`panel.json` 的 `speedTest*`，实现见 agg/site-test.js）——
 *                    测速是"这台机器与这条网络"的体检，与内容偏好无关，所以不跟模板走（见 ADR-0033）；
 *                    测速的结果（站点统计）也是面板级共享的一份。「立即测速」在「聚合 · 模板」页。
 *   · 缓存设置       面板自己那两份缓存的用量与清空（`data/emby/cache.db` 图片索引 +
 *                    `data/cache/lines.db` 线路结果 + 按插件的聚合耗时），端点 `GET|DELETE /api/panel/cache`，
 *                    策略存 `panel.json` 的 `cache.*`（见 core/cachedb.js）。⚠️ 插件自己的缓存在各自插件设置页。
 *
 * 其余按性质分在别页（同模块的侧栏子项）：
 *   · 「备份与还原」 导出 / 还原整份数据（见本文件 renderPanelBackup）
 *   · 「安全」       改面板密码（见 renderPanelSecurity）
 *   · 「概览」       面板重启 + 退出登录（整机动作，见 overview.js）
 *   · 「关于」       版本与更新 + 关于（"看看而已"，见 renderPanelAbout）
 *
 * ⚠️ **TMDB 设置不在这里**了：token / 基地址 / 语言 / 它自己的缓存都归**元数据插件**
 * （插件 → tmdb → 设置，见 plugins/metadata/tmdb/）。面板只从插件的「注册」动作里拿图片基地址。
 */
import { el, toast, fmtTime, codeBlock, modal, confirmModal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { BRAND } from '../../core/branding.js';
import { changePassword } from '../../core/auth.js';
import { renderPage } from '../../core/shell.js';

/* -------------------------------------------------------------- 版本与更新 */

/** 重启后的轮询节奏：间隔与总时限。重启时段内请求会被拒绝，属预期，不按错误处理。 */
const UPDATE_POLL_MS = 2000;
const UPDATE_POLL_LIMIT_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等面板重启完成：轮询 `/api/meta`，直到版本号与重启前不同。
 *
 * 返回新版本号；超过时限仍未取到则返回 null。请求失败一律继续等 —— 应用进程重启的那几秒
 * 连接会被拒绝，只有"能取到响应且版本已变"才算真的起来了。`/api/meta` 的 `version` 取自
 * 运行中的 `package.json`，因此它同时是"新版本是否真的在跑"的判据，而不是只看进程存活。
 */
async function waitRestart(prevVersion) {
  const deadline = Date.now() + UPDATE_POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    await sleep(UPDATE_POLL_MS);
    let meta = null;
    try {
      meta = await api('/api/meta');
    } catch {
      continue; // 面板还没起来
    }
    const v = meta && meta.version;
    if (v && v !== prevVersion) return v;
  }
  return null;
}

/**
 * 版本与更新卡。面板自身按 Release 安装新版本、重启应用进程生效（见 docs/adr/0019）。
 *
 * 数据来自 `GET /api/panel/update`，安装走 `POST /api/panel/update`。非受管运行方式
 * （直接跑源码、或进程不是由容器的监督者拉起）如实拒绝自更新：那种情况下没有可写回的
 * 安装目录，也没有重启后拉起新版本的监督者。
 *
 * 打开页面即查一次（摘要要如实显示"最新版本"只能来自这次请求），之后由「检查更新」手动触发。
 *
 * 卡上只有两颗按钮：「检查更新」只刷新摘要；「更新到 x」**先弹更新弹窗**（说明 + 真正执行更新的
 * 按钮，见 showNotes），点框里那颗才开始安装。原本另有一颗「查看更新内容」与"查到新版本就自动弹窗"
 * 两条入口，与更新弹窗重复，已去掉 —— 看说明这件事只在"决定要更新"的那一下发生。
 */
function updateCard() {
  /* 三行摘要先占「未知」：请求整体失败时仍有可读的摘要，不留空白 */
  const cur = el('span', { class: 'v', text: '未知' });
  const latest = el('span', { class: 'v', text: '未知' });
  const mode = el('span', { class: 'v', text: '未知' });
  const check = el('button', { class: 'btn', text: '检查更新' });
  const install = el('button', { class: 'btn primary hidden' });
  const result = el('div', { class: 'hint' });
  const versions = el('div', { class: 'note' });
  let last = null; // 最近一次 GET /api/panel/update 的结果

  const showResult = (cls, lines) => {
    result.className = cls;
    result.replaceChildren(...lines.map((t) => el('div', { text: t })));
  };

  /**
   * 安装某个版本：下载并安装 → 等面板重启到新版本 → 刷新页面。
   * 进度显示在卡片里（弹窗在点下「更新」后即关闭，避免把几十行说明一直挡在屏幕上）。
   * 由更新弹窗里的那颗「更新到 x」按钮触发（见 showNotes）；这里只管把动作做完。
   */
  const doInstall = async (target) => {
    const prev = (last && last.current) || '';
    check.disabled = true;
    install.disabled = true;
    showResult('hint', [`正在安装 ${target}…`]);
    try {
      const r0 = await api('/api/panel/update', { method: 'POST', body: { version: target } });
      const ver = r0.installed || target;
      toast(`已安装 ${ver}，面板正在重启`);
      showResult('hint', [`已安装 ${ver}，面板正在重启，页面会在几秒后自动恢复。`]);
      const now = await waitRestart(prev);
      if (now) {
        toast(`已更新到 ${now}`);
        showResult('hint', [`已更新到 ${now}，正在刷新页面…`]);
        setTimeout(() => location.reload(), 1500); // 留出看提示的时间，再取新版本的前端资源
        return;
      }
      const timeoutMsg = `面板未在 ${UPDATE_POLL_LIMIT_MS / 1000} 秒内恢复，请查看容器日志。`;
      showResult('hint warn', [timeoutMsg]);
      toast(timeoutMsg, true);
    } catch (e) {
      showResult('hint warn', ['更新失败：' + e.message]);
      toast('更新失败：' + e.message, true);
    }
    check.disabled = false;
    install.disabled = false;
  };

  /**
   * 更新弹窗 —— **点「更新到 x」才会弹**，里面摆两样东西：
   *   ① 该版本的更新说明（Release 说明 = CHANGELOG 里那一节，动辄几十行，所以弹窗展示而不是摊在卡片里）；
   *   ② 真正执行更新的那颗「更新到 x」按钮，**先倒计时 3 秒**才允许点：更新不可逆，
   *      这段等待留给"看更新内容"，不给"没看就点确定"的机会。
   * 框里同时给 GitHub 上那个 Release 的链接；该版本没写说明时**如实说一句**，不留白。
   */
  const showNotes = (r) => {
    if (!r) return;
    const title = `更新内容 · ${r.latest || ''}${r.publishedAt ? ` · 发布 ${fmtTime(r.publishedAt)}` : ''}`;
    const body = [];
    if (r.notes) body.push(codeBlock({ label: 'Release 说明', code: r.notes }));
    else body.push(el('div', { class: 'note', text: `这个版本（${r.latest}）的 Release 没有写更新说明。` }));
    if (r.notesUrl) {
      body.push(
        el(
          'div',
          { class: 'note' },
          '来源：',
          el('a', { href: r.notesUrl, target: '_blank', rel: 'noreferrer', text: 'GitHub 上的这个 Release' }),
          '（说明摘在该 Release 页与 CHANGELOG 里）'
        )
      );
    }

    const target = r.latest || '';
    let timer = null;
    const m = modal({
      title,
      body,
      actions: [
        { label: '取消' },
        /* onclick 不 await：弹窗立刻关掉，安装进度改在卡片里显示（见 doInstall） */
        { label: `更新到 ${target}`, primary: true, onclick: () => { doInstall(target); } },
      ],
      onClose: () => clearInterval(timer),
    });
    const go = m.root.querySelector('.modal-actions .btn.primary');
    if (!go) return;
    let left = 3;
    go.disabled = true; // 倒计时期间不可点
    go.textContent = `更新（${left}）`;
    timer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        go.textContent = `更新（${left}）`;
        return;
      }
      clearInterval(timer);
      timer = null;
      go.disabled = false; // 倒计时结束，才允许点
      go.textContent = `更新到 ${target}`;
    }, 1000);
  };

  const paint = (r) => {
    last = r;
    cur.textContent = r.current || '未知';
    latest.textContent = r.latest || '未知';
    mode.textContent = r.managed ? '受管（由容器引导）' : '非受管';
    const inst = Array.isArray(r.installed) ? r.installed : [];
    /* 更新即完整替换（见 docs/adr/0021）：旧版本在新版本启动后被清掉，
     * 所以这里只列磁盘上现有的版本，不再提"上一版" —— 它没有回退的意义。 */
    versions.textContent =
      (inst.length ? `已安装：${inst.join(' / ')}` : '已安装：未知') +
      (inst.length > 1 ? '（旧版本会在启动后被清理）' : '');

    const hasNew = !!(r.hasUpdate && r.latest);
    install.classList.toggle('hidden', !hasNew);
    install.disabled = !r.managed; // 非受管时不给按，避免按下去才报错
    if (hasNew) install.textContent = `更新到 ${r.latest}`;

    const lines = [];
    let cls = 'hint';
    if (!r.managed) {
      cls = 'hint warn';
      lines.push('当前不是由容器引导的运行方式，面板不能自更新。');
    } else if (hasNew) {
      lines.push(`有新版本 ${r.latest}（当前 ${r.current}）。`);
    } else if (!r.error) {
      lines.push(`已是最新（${r.current || '未知'}）。`);
    }
    if (r.error) {
      /* 排障信息原样带出，不吞 */
      cls = 'hint warn';
      lines.push('检查更新失败：' + r.error);
    }
    showResult(cls, lines);
  };

  /**
   * 检查更新：**只刷新摘要**（当前 / 最新 / 运行方式），由人看到有新版本后自己去点「更新到 x」。
   * 不在这一步弹窗 —— 弹窗是"决定要更新"之后才看的东西（更新说明 + 确认按钮，见 showNotes）。
   */
  const load = async (loud) => {
    check.disabled = true;
    check.innerHTML = '<span class="spinner"></span> 检查中…';
    try {
      const r = await api('/api/panel/update');
      paint(r);
    } catch (e) {
      showResult('hint warn', ['检查更新失败：' + e.message]);
      if (loud) toast('检查更新失败：' + e.message, true);
    } finally {
      check.disabled = false;
      check.textContent = '检查更新';
    }
  };

  check.addEventListener('click', () => load(true));

  /* 点「更新到 x」弹更新弹窗：先看说明，框里那颗「更新到 x」才是真正执行更新的按钮（见 showNotes） */
  install.addEventListener('click', () => {
    if (!(last && last.latest)) return;
    showNotes(last);
  });

  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: '版本与更新' }),
    el('p', {
      class: 'note',
      text: '面板可以从 Release 安装新版本，安装后应用进程会重启（容器不停）。更新只由你手动触发，不会在后台自动进行。更新即完整替换：新版本起来后，旧版本目录会被清掉。仓库地址见下面「关于」那张卡。',
    }),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '当前版本' }), cur),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '最新版本' }), latest),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '运行方式' }), mode),
    el('div', { class: 'row' }, check, install),
    result,
    versions
  );
  load(false);
  return card;
}

/* ------------------------------------------------------------------------ 关于 */

/**
 * 「关于」卡：面板叫什么、什么版本、代码在哪儿。
 * 仓库地址**来自后端**（`/api/panel/info` 的 `repo`/`repoUrl`，唯一来源是 update.js 的 REPO，
 * `APP_REPO` 可覆盖）—— 前端不写死，换仓库/自建时不用改前端。
 */
function aboutCard() {
  const name = el('span', { class: 'v', text: BRAND.panelName });
  const ver = el('span', { class: 'v', text: '…' });
  const repo = el('span', { class: 'v', text: '…' });
  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: '关于' }),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '名称' }), name),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '版本' }), ver),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '代码仓库' }), repo),
    el('p', {
      class: 'note',
      text: '面板按这个仓库的 Release 更新（资产 + sha256 校验，见上面「版本与更新」）；每个版本的更新说明都写在该 Release 页与仓库的 CHANGELOG 里。',
    })
  );

  api('/api/panel/info')
    .then((info) => {
      name.textContent = BRAND.panelName;
      ver.textContent = info.version || '-';
      repo.replaceChildren(
        info.repoUrl
          ? el('a', { href: info.repoUrl, target: '_blank', rel: 'noreferrer', text: info.repo || info.repoUrl })
          : el('span', { text: '（未设置）' })
      );
    })
    .catch((e) => {
      ver.textContent = '-';
      repo.textContent = '取仓库地址失败：' + e.message;
    });

  return card;
}

/* -------------------------------------------------------------- 备份与还原 */

function backupCard() {
  const out = el('div', { class: 'note' });
  const exportBtn = el('button', { class: 'btn primary', text: '导出备份' });
  const pickBtn = el('button', { class: 'btn', text: '选择文件还原' });
  const picked = el('span', { class: 'note' });
  /* 隐藏的 file input：点「选择文件还原」时打开系统选文件框 */
  const fileInput = el('input', { type: 'file', accept: '.zip,application/zip', class: 'hidden' });

  function fileName(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `catpaw-panel-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
  }

  /* 导出的是 zip 字节，不走 api()（那条封装一律按 JSON 解析）—— 直接 fetch 取 blob 下载。
     摘要（多少文件 / 多大）由后端放在响应头里：压缩包本身不便在前端解开一遍来数。 */
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const res = await fetch('/api/panel/backup');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const j = await res.json();
          if (j && j.error) msg = j.error;
        } catch {
          /* 响应体不是 JSON 时保留 HTTP 码作为提示 */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const name = fileName(new Date());
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const files = Number(res.headers.get('X-Backup-Files')) || 0;
      const bytes = Number(res.headers.get('X-Backup-Bytes')) || 0;
      const at = res.headers.get('X-Backup-Exported-At');
      out.className = 'note';
      out.textContent = `已导出 ${name}（${files} 个文件 / ${fmtBytes(bytes)}，不含缓存）${at ? ' · ' + fmtTime(at) : ''}`;
      toast('已导出 ' + name);
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '导出失败：' + e.message;
    } finally {
      exportBtn.disabled = false;
    }
  });

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 允许重复选同一个文件
    if (!file) return;
    picked.textContent = '已选择：' + file.name;

    /* 覆盖现有数据、不可撤销 —— 先把后果说清楚再确认（用页内确认框，不用原生 confirm） */
    const yes = await confirmModal({
      title: '用备份覆盖当前数据？',
      text:
        `会用「${file.name}」里的全部数据覆盖当前面板：设置、模板、插件（含插件数据）、` +
        `Emby 账号与播放进度都会被替换，缓存与应用代码不受影响。当前数据不会自动留档，` +
        `建议先「导出备份」存一份。覆盖后需重启面板才生效（到「概览」页点「面板重启」）。`,
      okLabel: '覆盖还原',
    });
    if (!yes) return;

    pickBtn.disabled = true;
    out.className = 'note';
    out.textContent = '正在上传并还原…';
    try {
      /* 直接把 File 当请求体（原始二进制），不做 base64 —— 全量备份可能有几十 MB */
      const res = await fetch('/api/panel/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      const restored = (data && data.restored) || [];
      toast('已还原：' + (restored.join(' / ') || '备份里没有数据'));
      out.className = 'note';
      out.textContent = `已还原 ${restored.length} 项（${restored.join(' / ') || '为空'}）：${(data && data.note) || '到「概览」页点「面板重启」使其生效。'}`;
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '还原失败：' + e.message;
    } finally {
      pickBtn.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '数据备份与还原' }),
    el('p', {
      class: 'note',
      text:
        '备份会打成一个 zip 包，包含数据卷里的全部数据：设置、模板、插件（含插件包与插件自己的数据）、' +
        'Emby 账号与播放进度。不含缓存（可随时重建）与应用代码（可从 Release 重新取得）。' +
        '还原会用 zip 里的数据整项覆盖当前数据卷，请先导出当前备份留档；覆盖后需重启面板才生效（「概览」页的「面板重启」）。',
    }),
    el('div', { class: 'note err-note', text: '备份含账号与插件凭证（如网盘 cookie/token），请妥善保管这份文件。' }),
    el('div', { class: 'toolbar' }, exportBtn, pickBtn, picked, fileInput),
    out
  );
}

/* ------------------------------------------------------------------ 缓存设置 */

/** 字节数 → 人话（用量显示用） */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 缓存设置（从「Emby → 连接设置」搬来）。
 *
 * 为什么归面板：剩下的这两份缓存都归面板用 —— `data/emby/cache.db`（图片索引，面板替客户端取图）
 * 与 `data/cache/lines.db`（线路结果 + 按插件的聚合耗时）。用量显示、清空、上限一把抓才可能不出错，
 * 所以设置、按钮、端点在面板层（`GET|DELETE /api/panel/cache`）。
 * ⚠️ **插件自己的缓存不在这里**：元数据、源插件的取数缓存都随插件走，归插件自己管
 * （插件 → tmdb → 设置、插件 → 源 → 设置）。
 */
function cacheCard() {
  const c = (S.panel.settings || {}).cache || {};
  /* 这几个是**默认值**，改了就落盘；留空/非数字由后端兜底回默认 */
  const cnum = (key, dflt) =>
    el('input', { type: 'text', value: String(c[key] === undefined || c[key] === null ? dflt : c[key]), class: 'w-sm' });
  const cImgDays = cnum('imageTtlDays', 90);
  const cImgMB = cnum('imageMaxMB', 5);
  const cLineDays = cnum('linesTtlDays', 1);
  const cLineMB = cnum('linesMaxMB', 32);
  const cLineForever = el('input', { type: 'checkbox' });
  cLineForever.checked = !!c.linesNeverExpire;
  const out = el('div', { class: 'hint', text: '正在读取用量…' });
  const aggLine = el('div', { class: 'note' });
  const save = el('button', { class: 'btn primary', text: '保存' });
  const clear = el('button', { class: 'btn', text: '清空缓存' });

  /** 线路结果的有效期显示：勾了长期有效就说长期有效，填 0 就说不缓存 */
  const fmtLineTtl = (r) => {
    const d = r.lines || {};
    if (d.ttlForever) return '长期有效';
    const days = Number(d.ttlMs || 0) / 86400000;
    return days > 0 ? `${days} 天` : '不缓存';
  };

  /**
   * 按插件记的**最近一次聚合耗时**（ADR-0032 第 4 条，数据来自 `r.agg`）——
   * 一次聚合同时打几个插件，总耗时说不出是谁慢，所以按插件各记一笔。
   * 没记过就留空（如实，不编）。
   */
  const paintAgg = (r) => {
    const agg = r.agg || {};
    const ids = Object.keys(agg);
    aggLine.textContent = '';
    if (!ids.length) return;
    aggLine.append(
      '各插件最近一次聚合耗时：' +
        ids
          .map((id) => {
            const a = agg[id] || {};
            return `${id} 最慢一发 ${Math.round(Number(a.ms) || 0)}ms（${Number(a.sites) || 0} 站）`;
          })
          .join(' · ')
    );
  };

  const paint = (r) => {
    const d = r.lines || { rows: 0, bytes: 0, maxBytes: 0 };
    out.textContent = '';
    out.append(
      `图片索引 ${r.image.rows} 条 / ${fmtBytes(r.image.bytes)}（上限 ${fmtBytes(r.image.maxBytes)}）` +
        ` · 线路结果 ${d.rows} 条 / ${fmtBytes(d.bytes)}（上限 ${fmtBytes(d.maxBytes)}，当期有效期 ${fmtLineTtl(r)}）`
    );
    paintAgg(r);
  };
  const load = async () => {
    try {
      paint(await api('/api/panel/cache'));
    } catch (e) {
      out.textContent = '读取用量失败：' + e.message;
    }
  };
  load();

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api('/api/modules/panel/settings', {
        method: 'PUT',
        body: {
          settings: {
            cache: {
              imageTtlDays: Number(cImgDays.value),
              imageMaxMB: Number(cImgMB.value),
              /* 留空**不要**当成 0 —— 这个字段的 0 是"不缓存"，留空的意思是"用默认值"，
               * 所以留空发 undefined（JSON 会把它丢掉，后端按默认值算）。 */
              linesTtlDays: cLineDays.value.trim() === '' ? undefined : Number(cLineDays.value),
              /* 同上：留空 = 用默认值（32MB），填 0 才是"不限" */
              linesMaxMB: cLineMB.value.trim() === '' ? undefined : Number(cLineMB.value),
              linesNeverExpire: cLineForever.checked,
            },
          },
        },
      });
      S.panel.settings = r.settings;
      toast('缓存设置已保存');
      await load(); // 上限调小后这里能立刻看到淘汰结果（后端在设置变更时会扫一遍）
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  clear.addEventListener('click', async () => {
    if (
      !confirm(
        '清空本地缓存？\n\n图片索引与线路结果都会重来（下一次点开会重新搜源）。\n账号在另一个库里，不受影响、不用重新登录。'
      )
    ) {
      return;
    }
    clear.disabled = true;
    try {
      paint(await api('/api/panel/cache', { method: 'DELETE' }));
      toast('缓存已清空');
    } catch (e) {
      toast('清空失败：' + e.message, true);
    } finally {
      clear.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '缓存设置' }),
    el('p', {
      class: 'note',
      text:
        '缓存图片索引：客户端不带 tag 来要图时靠它答出"这张图在哪儿"，也让面板少找一次上游；' +
        '另有一层「线路结果」缓存：把「这部片在源里有哪些线路、这一集定位到哪一条」存起来（客户端点一次播放会连问三遍同一件事，' +
        '靠它省掉后两遍）；还有「站点测速」那份统计（站点表里那两列速度就是它）。清空不影响账号，也不用重新登录。',
    }),
    el('p', {
      class: 'note',
      text:
        '天数填 0 = 不缓存；上限填 0 = 不限（不淘汰）。两个 0 意思不一样，别当成一回事。' +
        '「线路结果」勾了长期有效就不按天数过期（改了站点勾选 / 分数线这类设置会立刻换一份新的，不会读到旧结论）。',
    }),
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'muted', text: '图片索引' }),
      cImgDays,
      el('span', { class: 'muted', text: '天 · 上限' }),
      cImgMB,
      el('span', { class: 'muted', text: 'MB' })
    ),
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'muted', text: '线路结果（线路 + 定位）' }),
      cLineDays,
      el('span', { class: 'muted', text: '天 · 上限' }),
      cLineMB,
      el('span', { class: 'muted', text: 'MB' }),
      el('label', { class: 'chk' }, cLineForever, '长期有效'),
      save,
      clear
    ),
    out,
    aggLine
  );
}

/** 设置要异步读一次，先占位再把卡换进去 */
async function cacheSection(v) {
  const holder = el('div');
  v.append(holder);
  holder.append(el('div', { class: 'card' }, el('h3', { text: '缓存设置' }), el('div', { class: 'muted', text: '正在读取面板设置…' })));
  try {
    if (!S.panel.settings) S.panel.settings = (await api('/api/modules/panel/settings')).settings;
  } catch (e) {
    holder.replaceChildren(
      el('div', { class: 'card' }, el('h3', { text: '缓存设置' }), el('div', { class: 'hint warn', text: '读取面板设置失败：' + e.message }))
    );
    return;
  }
  holder.replaceChildren(cacheCard());
}

/* ------------------------------------------------------------------ 面板密码 */

function passwordCard() {
  const oldInput = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '当前密码' });
  const newInput = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '新密码（至少 6 位）' });
  const againInput = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '再输一次' });
  const btn = el('button', { class: 'btn primary', text: '修改密码' });
  const warn = el('div', { class: 'note err-note hidden' });

  btn.addEventListener('click', async () => {
    warn.classList.add('hidden');
    const show = (m) => {
      warn.textContent = m;
      warn.classList.remove('hidden');
    };
    if (!oldInput.value || !newInput.value) return show('请填写当前密码与新密码');
    if (newInput.value !== againInput.value) return show('两次输入的新密码不一致');
    if (newInput.value.length < 6) return show('新密码至少 6 位');
    btn.disabled = true;
    try {
      await changePassword(oldInput.value, newInput.value);
      /* 改完旧登录就失效了 —— 明确回到登录页 */
      toast('密码已修改，请用新密码重新登录');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      show(e.message);
      btn.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '面板密码' }),
    el('p', { class: 'note', text: '登录这个面板要用的密码。改完之后要重新登录（浏览器里 30 天不用再输）。' }),
    el('div', { class: 'row' }, oldInput, newInput, againInput, btn),
    warn
  );
}

/**
 * 「站点测速」卡：开关 + 间隔。
 *
 * 从「聚合参数」页挪来的：测速是"**这台机器与这条网络**"的体检，与内容偏好无关 ——
 * 所以它不跟模板走（模板装的是内容偏好），而测速的**结果**（站点统计）也是面板级共享的一份。
 * 「立即测速」按钮仍在「聚合 · 模板」页（那是"看结果 + 手点一轮"）。
 */
function speedTestSection(v) {
  (async () => {
    if (!S.panel.settings) S.panel.settings = (await api('/api/modules/panel/settings')).settings;
    const p = S.panel.settings || {};
    const on = el('input', { type: 'checkbox', checked: p.speedTestAuto !== false });
    const hours = el('input', {
      type: 'number',
      class: 'w-sm',
      value: String(p.speedTestHours === undefined || p.speedTestHours === null ? 6 : p.speedTestHours),
      min: '1',
      max: '168',
    });
    const save = el('button', { class: 'btn primary', text: '保存' });
    save.addEventListener('click', async () => {
      const h = Number(hours.value);
      if (!(h >= 1 && h <= 168)) return toast('测速间隔填 1~168 小时', true);
      save.disabled = true;
      try {
        const r = await api('/api/modules/panel/settings', {
          method: 'PUT',
          body: { settings: { speedTestAuto: on.checked, speedTestHours: h } },
        });
        S.panel.settings = r.settings || Object.assign({}, p, { speedTestAuto: on.checked, speedTestHours: h });
        toast(on.checked ? `已保存（每 ${h} 小时自动测一轮）` : '已保存（自动测速已关）');
      } catch (e) {
        toast('保存失败：' + e.message, true);
      } finally {
        save.disabled = false;
      }
    });
    v.append(
      el(
        'div',
        { class: 'card' },
        el('h3', { text: '站点测速' }),
        el(
          'div',
          { class: 'row' },
          el(
            'label',
            { class: 'chk', title: '每站打一发 POST /search（片名从常见影视名里随机取、非 200 换一个再测一发），结果写进「聚合 · 模板」页那一列「延迟」' },
            on,
            '自动测速（全部站点）'
          ),
          el('label', { class: 'chk', title: '多久测一轮，1~168 小时；改完从现在重新计时' }, hours, '小时'),
          save
        ),
        el('div', {
          class: 'note',
          text:
            '测速是"这台机器与这条网络"的体检，与内容偏好无关 —— 所以不跟模板走，测速的结果也是面板级共享的一份。' +
            '这里只管自动测速；要立刻测一轮，去「聚合 · 模板」页点「立即测速」。',
        })
      )
    );
  })().catch((e) => v.append(el('div', { class: 'hint warn', text: '读取测速设置失败：' + e.message })));
}

export function renderPanelSettings(v) {
  /* 缓存卡要异步读一次设置，往 v 末尾插，不挡上面的卡。 */
  speedTestSection(v);
  cacheSection(v);
}

/**
 * 「备份与还原」页：只有那一张卡。
 *
 * 从「设置」页拆出来单开一页 —— 备份/还原是**低频但后果重**的操作（还原会整项覆盖数据卷），
 * 跟"改个数字就生效"的测速、缓存摆在一起，容易被顺手点。
 */
export function renderPanelBackup(v) {
  v.append(backupCard());
}

/**
 * 「安全」页：改面板密码。
 *
 * 从「设置」页拆出来单开一页 —— 密码是**登录这个面板的凭据**，与"面板怎么跑"的设置不是一类；
 * 退出登录挪去了「概览」页（那里是整机动作）。
 */
export function renderPanelSecurity(v) {
  v.append(passwordCard());
}

/**
 * 「关于」页：**版本与更新** + **关于**两张卡。
 *
 * 从「设置」页挪过来的：「设置」页是"要动手改的东西"（缓存/测速），
 * 而这两张是"看看而已" —— 更新卡里那段说明还动辄几十行，摆在设置页会把要改的卡挤到很下面。
 */
export function renderPanelAbout(v) {
  v.append(updateCard(), aboutCard());
}
