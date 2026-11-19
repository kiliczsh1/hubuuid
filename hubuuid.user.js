// ==UserScript==
// @name         hubuuid
// @namespace    https://github.com/kiliczsh1/hubuuid
// @version      2.1.0
// @description  把贴吧里出现的 GitHub 仓库文件名变成可点击链接，文本类文件弹窗预览；支持导入多个仓库
// @author       kiliczsh1
// @match        https://tieba.baidu.com/f*
// @match        https://tieba.baidu.com/p/*
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/kiliczsh1/hubuuid/main/hubuuid.user.js
// @updateURL    https://raw.githubusercontent.com/kiliczsh1/hubuuid/main/hubuuid.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============ 配置区 ============
    // 默认值。页面右下角齿轮里可以改，改完存在你自己的浏览器里，不影响别人
    const DEFAULT_CONF = {
        repos: [],      // [{owner, repo, branch}]，最多 MAX_REPOS 个
        branch: 'main', // 导入地址里没写分支时用这个
        prefix: '',     // 留空 = 走 GitHub raw；填了就用这个前缀拼地址（比如换成加速镜像）
        forums: ''      // 只在哪些吧生效；留空 = 所有吧都生效
    };

    const CONF_KEY = 'gg_repo_conf_v2';
    const OLD_CONF_KEY = 'gg_repo_conf_v1';
    const MAX_REPOS = 20;

    let CONF = { repos: [], branch: 'main', prefix: '', forums: '' };

    // 读配置。v1 存的是单个仓库，这里自动升成仓库列表
    (function loadConf() {
        try {
            const c = JSON.parse(localStorage.getItem(CONF_KEY) || 'null');
            if (c && Array.isArray(c.repos)) {
                CONF = Object.assign({}, DEFAULT_CONF, c);
                CONF.repos = CONF.repos
                    .filter(r => r && r.owner && r.repo)
                    .map(r => ({ owner: r.owner, repo: r.repo, branch: r.branch || CONF.branch || 'main' }))
                    .slice(0, MAX_REPOS);
                return;
            }
            const old = JSON.parse(localStorage.getItem(OLD_CONF_KEY) || 'null');
            if (old && old.owner && old.repo) {
                CONF = {
                    repos: [{ owner: old.owner, repo: old.repo, branch: old.branch || 'main' }],
                    branch: 'main',
                    prefix: old.prefix || '',
                    forums: old.forums || ''
                };
            }
        } catch (e) {}
    })();

    const confReady = () => CONF.repos.length > 0;

    const cacheKey = (r) => `gg_idx_${r.owner}_${r.repo}_${r.branch}`;

    const apiUrl = (r) =>
        `https://api.github.com/repos/${r.owner}/${r.repo}/contents/?ref=${encodeURIComponent(r.branch)}`;

    // 生成文件地址：默认走 raw，md 可选走 GitHub 网页（渲染）
    function fileUrl(f) {
        const encoded = String(f.name).split('/').map(encodeURIComponent).join('/');
        if (mdRenderOn() && /\.md$/i.test(f.name)) {
            return `https://github.com/${f.owner}/${f.repo}/blob/${f.branch}/${encoded}`;
        }
        const p = (CONF.prefix || '').trim();
        if (p) {
            const base = p.replace(/\/+$/, '') + '/';
            return base
                .replace(/\{owner\}/g, f.owner)
                .replace(/\{repo\}/g, f.repo)
                .replace(/\{branch\}/g, f.branch) + encoded;
        }
        return `https://raw.githubusercontent.com/${f.owner}/${f.repo}/${f.branch}/${encoded}`;
    }

    // 文件清单缓存多久（毫秒）。往仓库加了新文件，最多等这么久才会被认出来
    const CACHE_TTL = 60 * 60 * 1000;

    // 这些名字太普通，帖子里正常出现不该变成链接
    const BLACKLIST = ['license', 'readme.md', 'readme', '.gitignore', 'index.html', 'package.json'];

    // 文件名后面紧跟的防吞占位，命中就连同它一起吃掉
    const NOISE_AFTER = /^[ \t\u3000]*第[ \t\u3000]*\d+[ \t\u3000]*楼/;

    const DROP_EMOJI_AFTER = true;

    // 链接和后面那串楼层灰字（时间/IP/赞/回复）的间距，嫌挤就调大
    const LINK_GAP = '6px';

    // .md 文件默认打开方式（页面右下角有按钮可以随时切换，切换结果会记住）
    // false = 走 raw，打开是纯文本源码，加载快（15KB）
    // true  = 走 github.com/blob，渲染好看，但要拉整个页面（约 240KB），国内可能很慢或 429
    const MD_VIA_BLOB = false;

    // 右下角要不要显示切换按钮
    const SHOW_TOGGLE = true;
    // ================================

    const modeKey = () => `gg_md_mode_${CONF.repos.map(r => r.owner + '_' + r.repo).join('+') || 'none'}`;

    // 当前实际生效的模式：用户点过按钮就用用户的，否则用上面的默认值
    function mdRenderOn() {
        try {
            const v = localStorage.getItem(modeKey());
            if (v === '1') return true;
            if (v === '0') return false;
        } catch (e) {}
        return MD_VIA_BLOB;
    }

    function setMdRender(on) {
        try { localStorage.setItem(modeKey(), on ? '1' : '0'); } catch (e) {}
    }

    // 只有"文件名合法字符"组成的片段才允许拼接。
    // 含中文的（22分钟前 / 河南 / 赞 / 回复）一律不碰 —— 它们有自己的样式和位置。
    const NAME_CHUNK = /^[0-9A-Za-z._~\-]+$/;
    // 判断这段字符有没有可能是某个文件名的开头 —— 拼接只在这条成立时才做
    function couldBePrefix(s) {
        if (!s) return false;
        const low = s.toLowerCase();
        for (const k of FILE_MAP.keys()) {
            if (k.startsWith(low)) return true;
        }
        return false;
    }

    // 从文本开头取出连续的"文件名可能字符"，返回 [head, rest]
    function splitHead(t) {
        const m = t.match(/^[0-9A-Za-z._~\-]+/);
        if (!m) return ['', t];
        return [m[0], t.slice(m[0].length)];
    }

    // ================================

    // 小写名 -> {name, owner, repo, branch}
    let FILE_MAP = new Map();
    let NAME_RE = null;

    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function buildIndex(files) {
        FILE_MAP = new Map();

        // 同名不同扩展名（a.md / a.jpg）时，不带扩展名的写法有歧义，不收录
        const stemCount = new Map();
        files.forEach(f => {
            if (!f || !f.name) return;
            const s = f.name.replace(/\.[^.]+$/, '').toLowerCase();
            stemCount.set(s, (stemCount.get(s) || 0) + 1);
        });

        files.forEach(f => {
            if (!f || !f.name) return;
            const low = f.name.toLowerCase();
            if (BLACKLIST.includes(low)) return;

            // 多个仓库有同名文件时，先到的优先
            if (!FILE_MAP.has(low)) FILE_MAP.set(low, f);

            // 不带扩展名的写法也认：只对"够长、含数字、且唯一"的名字开，避免撞上普通英文单词
            const stem = f.name.replace(/\.[^.]+$/, '');
            const key = stem.toLowerCase();
            if (stem.length >= 8 && /\d/.test(stem) && stemCount.get(key) === 1 && !FILE_MAP.has(key)) {
                FILE_MAP.set(key, f);
            }
        });

        const keys = [...FILE_MAP.keys()].sort((a, b) => b.length - a.length); // 长的优先
        NAME_RE = keys.length
            ? new RegExp('\\b(' + keys.map(esc).join('|') + ')\\b', 'gi')
            : null;
    }

    // 同一文本节点里紧跟"第N楼"的，一起吃掉
    function eatNoise(text, end) {
        const m = text.slice(end).match(NOISE_AFTER);
        return m ? end + m[0].length : end;
    }

    // 链接插好之后，清理后面紧跟的防吞内容
    function trimAfter(node) {
        let n = node.nextSibling;
        while (n) {
            if (n.nodeType === Node.TEXT_NODE) {
                const t = n.textContent;
                const m = t.match(NOISE_AFTER);
                if (m) {
                    const rest = t.slice(m[0].length);
                    if (rest.trim()) { n.textContent = rest; break; }
                    const dead = n; n = n.nextSibling; dead.remove(); continue;
                }
                if (!t.trim()) { n = n.nextSibling; continue; }
                break;
            }
            if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'IMG' && DROP_EMOJI_AFTER) {
                const dead = n; n = n.nextSibling; dead.remove(); continue;
            }
            break;
        }
    }

    function processTextNode(node) {
        if (node.nodeType !== Node.TEXT_NODE) return;
        if (!NAME_RE) return;

        const text = node.textContent;
        if (!text || text.length < 8) return;

        NAME_RE.lastIndex = 0;
        if (!NAME_RE.test(text)) return;
        NAME_RE.lastIndex = 0;

        const fragments = [];
        let lastIndex = 0;
        let match;
        let hit = false;

        while ((match = NAME_RE.exec(text)) !== null) {
            const f = FILE_MAP.get(match[0].toLowerCase());
            if (!f) continue;

            hit = true;

            if (match.index > lastIndex) {
                fragments.push(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const end = eatNoise(text, NAME_RE.lastIndex);

            const a = document.createElement('a');
            a.href = fileUrl(f);
            a.dataset.file = f.name;                              // 真实文件名
            a.dataset.repo = `${f.owner}/${f.repo}/${f.branch}`;  // 来自哪个仓库，切换模式时重算地址用
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = a.href;
            a.textContent = match[0];   // 显示原样
            a.style.textDecoration = 'none';
            a.style.borderBottom = '1px dashed #4a90d9';
            a.style.marginRight = LINK_GAP;

            // 左键点开弹窗预览；Ctrl/⌘/Shift 点或中键仍然走浏览器默认行为
            a.addEventListener('click', (ev) => {
                if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
                if (!previewKind(f.name)) return;   // 图片、压缩包、pdf 等直接开原链接
                ev.preventDefault();
                openPreview(f, a.href);
            });

            fragments.push(a);

            // md 文件在链接后面跟一个切换小按钮
            if (SHOW_TOGGLE && /\.md$/i.test(f.name)) {
                const t = makeMdToggle();
                t.textContent = mdRenderOn() ? '渲染' : '原文';
                t.title = mdRenderOn()
                    ? '.md 打开后是排版好的网页，点这里改成纯文本'
                    : '.md 打开后是纯文本源码，点这里改成排版网页';
                fragments.push(t);
            }

            lastIndex = end;
            NAME_RE.lastIndex = end;
        }

        if (!hit) return;

        if (lastIndex < text.length) {
            fragments.push(document.createTextNode(text.slice(lastIndex)));
        }

        const wrapper = document.createElement('span');
        wrapper.setAttribute('data-repo-link', '1');   // 只作标记，不用于跳过
        // display:contents 让这层 span 不产生盒子，子节点直接按父级布局，
        // 这样不会把原本分行的内容挤到一行
        wrapper.style.display = 'contents';
        fragments.forEach(f => wrapper.appendChild(f));
        node.parentNode.replaceChild(wrapper, node);
        trimAfter(wrapper);
    }

    // 贴吧把表情做成 <img> 插在文字中间，会把文件名切成两块，先接回去
    function mergeAroundEmoji(el) {
        const imgs = Array.from(el.childNodes).filter(n => n.nodeType === 1 && n.tagName === 'IMG');
        if (!imgs.length) return;

        imgs.forEach(n => n.remove());

        let prev = null;
        const dead = [];
        Array.from(el.childNodes).forEach(n => {
            if (n.nodeType !== Node.TEXT_NODE) { prev = null; return; }

            const t = n.textContent;
            if (!t.trim()) { if (prev) { prev.textContent += t; dead.push(n); } return; }

            const [head, rest] = splitHead(t);

            if (!prev) {
                // 自己有可能成为文件名开头才留作候选
                if (head && couldBePrefix(head)) prev = n;
                return;
            }

            const merged = prev.textContent + head;
            if (head && couldBePrefix(merged)) {
                prev.textContent = merged;
                if (rest) n.textContent = rest; else dead.push(n);
            } else {
                prev = null;   // 拼不成文件名，断开，绝不硬拼
            }
        });
        dead.forEach(n => n.remove());
    }

    function mergeInComment(el) {
        const cls = el.getAttribute && el.getAttribute('class');
        if (!cls || !cls.includes('comment-content')) return;

        const nodes = [];
        (function collect(node) {
            for (const n of node.childNodes) {
                if (n.nodeType === Node.TEXT_NODE) nodes.push(n);
                else if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'IMG') collect(n);
            }
        })(el);

        let prev = null;
        const dead = [];
        nodes.forEach(n => {
            const t = n.textContent;
            if (!t.trim()) return;

            const [head, rest] = splitHead(t);

            if (!prev) { prev = n; return; }

            // 前一段可能是 "...看 17934" 这种，取它末尾的 ASCII 片段来拼
            const tail = (prev.textContent.match(/([0-9A-Za-z._~\-]+)$/) || ['', ''])[1];
            const merged = tail + head;

            if (head && tail && couldBePrefix(merged)) {
                prev.textContent += head;      // 接到前一段末尾
                if (rest) n.textContent = rest; else dead.push(n);
            } else {
                prev = n;                       // 拼不成，当前节点变成新的起点
            }
        });
        dead.forEach(n => n.remove());
    }

    function processElement(el) {
        if (!el.tagName) return;
        if (/^(SCRIPT|STYLE|NOSCRIPT|A|TEXTAREA|INPUT|BUTTON)$/.test(el.tagName)) return;
        if (el.namespaceURI === 'http://www.w3.org/2000/svg') return;
        if (el.getAttribute && el.getAttribute('data-gg-skip')) return;

        try { mergeAroundEmoji(el); } catch (e) {}
        try { mergeInComment(el); } catch (e) {}

        Array.from(el.childNodes).forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                try { processTextNode(node); } catch (e) {}
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                processElement(node);
            }
        });
    }

    // 当前所在的吧
    function currentForum() {
        // 吧列表页：地址栏里就有
        const kw = new URLSearchParams(location.search).get('kw');
        if (kw) return decodeURIComponent(kw).toLowerCase();

        // 帖子页：找「xx吧 关注N 贴子M」那个链接（侧栏推荐吧没有这两个计数）
        const cands = Array.from(document.querySelectorAll('a[href*="/f?kw="]'));
        const hit = cands.find(a => /关注\s*\d+|贴子\s*\d+/.test(a.textContent));
        if (hit) {
            const m = (hit.getAttribute('href') || '').match(/[?&]kw=([^&]+)/);
            if (m) return decodeURIComponent(m[1]).toLowerCase();
        }
        return '';
    }

    // 配置里的吧名单是否包含当前吧；认不出来就放行，宁可不误拦
    function forumAllowed() {
        const list = (CONF.forums || '')
            .split(/[\n,，、\s]+/)
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
        if (!list.length) return true;

        const cur = currentForum();
        if (!cur) return true;

        return list.includes(cur);
    }

    // 状态行：主要显示"当前识别到哪个吧"，出问题再追加原因
    function forumLabel() {
        const cur = currentForum();
        if (!cur) return '未识别到吧名';
        return '当前吧：' + cur + (forumAllowed() ? '' : '（不在生效列表，不处理）');
    }

    function statusText() {
        if (!confReady()) return '还没导入仓库，在下面粘贴一个仓库地址';
        const forum = forumLabel();
        const s = INDEX_STATE;
        if (s.status === 'fail') return forum + ' ｜ ' + s.msg;
        if (s.status === 'loading') return forum + ' ｜ 正在读取清单…';
        if (s.status === 'stale') return forum + ' ｜ 清单更新中…';
        return forum;
    }

    function statusKind() {
        if (!confReady()) return 'stale';
        if (INDEX_STATE.status === 'fail') return 'fail';
        if (INDEX_STATE.status === 'loading' || INDEX_STATE.status === 'stale') return 'stale';
        return forumAllowed() ? 'ok' : 'stale';
    }

    function paintStatus() {
        const el = document.querySelector('.gg-status');
        if (!el) return;
        el.textContent = statusText();
        el.dataset.state = statusKind();
    }

    function paintGear() {
        const g = document.querySelector('button[data-gg-gear]');
        if (!g) return;
        const s = INDEX_STATE.status;
        if (s === 'fail') {
            g.style.background = 'linear-gradient(135deg,#9aa9bb,#77879c)';
            g.title = '仓库设置（清单读取失败，点开看看）';
        } else if (s === 'ok') {
            g.style.background = 'linear-gradient(135deg,#ff8a3d,#ff4f7d)';
            g.title = '仓库设置';
        } else {
            g.style.background = 'linear-gradient(135deg,#ffb36b,#ff9aae)';
            g.title = '仓库设置（正在读取清单）';
        }
    }

    // 右下角齿轮：打开设置面板，改仓库地址
    function mountSettings() {
        if (document.querySelector('button[data-gg-gear]')) return;

        const css = document.createElement('style');
        css.textContent = [
            '.gg-gear{position:fixed;right:18px;bottom:18px;width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff8a3d,#ff4f7d);color:#fff;box-shadow:0 4px 14px rgba(255,79,125,.45);transition:transform .18s,box-shadow .18s;padding:0}',
            '.gg-gear:hover{transform:rotate(45deg) scale(1.06);box-shadow:0 6px 20px rgba(255,79,125,.6)}',
            '.gg-gear svg{width:22px;height:22px;fill:currentColor;pointer-events:none}',
            '.gg-panel{position:fixed;right:18px;bottom:74px;width:292px;max-width:calc(100vw - 36px);z-index:2147483001;background:#fff;border-radius:12px;box-shadow:0 10px 36px rgba(20,40,70,.22);padding:15px 16px;font-size:13px;color:#33455c;display:none;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
            '.gg-panel.on{display:block}',
            '.gg-panel h4{margin:0 0 11px;font-size:14px;color:#1f3550}',
            '.gg-panel label{display:block;margin-bottom:9px}',
            '.gg-panel label span{display:block;margin-bottom:3px;font-size:12px;color:#7b8ea6}',
            '.gg-panel input,.gg-panel textarea{width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;border:1px solid #d5dfea;border-radius:6px;outline:none;font-family:inherit;color:#22384f;background:#fff}',
            '.gg-tags{display:none;flex-wrap:wrap;gap:5px;margin-bottom:5px}',
            '.gg-tag{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#eef3fa;color:#41618a;font-size:12px;line-height:1.5}',
            '.gg-tag b{cursor:pointer;color:#9aabbd;font-weight:400;padding:0 1px}',
            '.gg-tag b:hover{color:#d0453f}',
            '.gg-panel input:focus,.gg-panel textarea:focus{border-color:#ff8a3d;box-shadow:0 0 0 3px rgba(255,138,61,.15)}',
            '.gg-btns{display:flex;gap:8px;margin-top:12px}',
            '.gg-btns button{flex:1;padding:7px 0;border-radius:7px;border:1px solid #d5dfea;background:#fff;color:#5a7086;cursor:pointer;font-size:13px;font-family:inherit}',
            '.gg-btns button[data-act="save"]{background:linear-gradient(135deg,#ff8a3d,#ff4f7d);border:none;color:#fff;font-weight:600}',
            '.gg-status{margin:-4px 0 11px;padding:6px 9px;border-radius:6px;font-size:12px;background:#f1f5fa;color:#6b86a6;line-height:1.5}',
            '.gg-status[data-state="ok"]{background:#eef8f0;color:#3f8a52}',
            '.gg-status[data-state="fail"]{background:#fdeeee;color:#c0443f}',
            '.gg-status[data-state="stale"]{background:#fdf6e8;color:#a97a22}',
            '.gg-flash{font-size:11px;color:#d0453f;line-height:1.5;min-height:13px;margin-top:2px}',
            '.gg-panel code{background:#f1f5fa;padding:1px 3px;border-radius:3px;font-size:11px;color:#41618a}',
            '.gg-hint{margin-top:9px;font-size:11px;color:#9aa9bb;line-height:1.55}'
        ].join('\n');
        document.head.appendChild(css);

        const gear = document.createElement('button');
        gear.setAttribute('data-gg-gear', '1');
        gear.type = 'button';
        gear.className = 'gg-gear';
        gear.title = '仓库设置';
        gear.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.07.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 15.6 12 3.6 3.6 0 0 1 12 15.6z"/></svg>';

        const panel = document.createElement('div');
        panel.className = 'gg-panel';
        panel.setAttribute('data-gg-skip', '1');
        panel.innerHTML = [
            '<h4>仓库设置</h4>',
            '<div class="gg-status" data-state="idle">正在识别当前吧…</div>',
            '<label><span>仓库列表（最多 ' + MAX_REPOS + ' 个）</span>',
            '<div class="gg-tags" data-box="repos"></div>',
            '<input data-import placeholder="粘贴仓库地址，回车导入">',
            '<div class="gg-flash" data-flash></div>',
            '</label>',
            '<label><span>默认分支（地址里没写分支时用）</span><input data-k="branch" placeholder="main"></label>',
            '<label><span>生效的吧（回车确认，留空 = 全部）</span>',
            '<div class="gg-tags" data-box="forums"></div>',
            '<input data-k="forums" placeholder="输入吧名，按回车添加">',
            '</label>',
            '<label><span>自定义前缀（可留空）</span><input data-k="prefix" placeholder="https://raw.githubusercontent.com/..."></label>',
            '<div class="gg-btns">',
            '<button data-act="reset" type="button">恢复默认</button>',
            '<button data-act="save" type="button">保存并刷新</button>',
            '</div>',
            '<div class="gg-btns"><button data-act="reload" type="button">重新读取文件清单</button></div>',
            '<div class="gg-hint">导入支持 <code>github.com/用户名/仓库</code>、<code>用户名/仓库</code>、带 <code>/tree/分支</code> 的地址。前缀里可用 <code>{owner}</code> <code>{repo}</code> <code>{branch}</code> 占位。</div>'
        ].join('');

        let forumTags = [];
        let repoList = [];
        let flashTimer = null;

        function flashHint(msg) {
            const el = panel.querySelector('[data-flash]');
            if (!el) return;
            el.textContent = msg;
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => { el.textContent = ''; }, 2000);
        }

        function makeChip(text, tip, onRemove) {
            const t = document.createElement('span');
            t.className = 'gg-tag';
            t.textContent = text;
            if (tip) t.title = tip;
            const x = document.createElement('b');
            x.textContent = '\u00d7';
            x.addEventListener('click', onRemove);
            t.appendChild(x);
            return t;
        }

        function renderRepos() {
            const box = panel.querySelector('.gg-tags[data-box="repos"]');
            box.innerHTML = '';
            repoList.forEach((r, i) => {
                box.appendChild(makeChip(
                    r.owner + '/' + r.repo,
                    '分支：' + r.branch + '　点 × 移除',
                    () => { repoList.splice(i, 1); renderRepos(); }
                ));
            });
            box.style.display = repoList.length ? 'flex' : 'none';
        }

        function renderForums() {
            const box = panel.querySelector('.gg-tags[data-box="forums"]');
            box.innerHTML = '';
            forumTags.forEach((name, i) => {
                box.appendChild(makeChip(name, '点 × 移除', () => {
                    forumTags.splice(i, 1);
                    renderForums();
                }));
            });
            box.style.display = forumTags.length ? 'flex' : 'none';
        }

        // 把用户粘进来的地址拆成 owner / repo / branch
        function parseRepo(str) {
            let t = String(str || '').trim();
            if (!t) return null;
            t = t.replace(/^[<（(]+|[>）)]+$/g, '').replace(/\.git$/i, '');

            let m = t.match(/raw\.githubusercontent\.com\/([^\/\s]+)\/([^\/\s]+)\/([^\/\s]+)/i);
            if (m) return { owner: m[1], repo: m[2], branch: m[3] };

            m = t.match(/github\.com\/([^\/\s]+)\/([^\/\s?#]+)(?:\/(?:tree|blob)\/([^\/\s?#]+))?/i);
            if (m) return { owner: m[1], repo: m[2], branch: m[3] || '' };

            m = t.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w.\/-]+))?$/);
            if (m) return { owner: m[1], repo: m[2], branch: m[3] || '' };

            return null;
        }

        function addRepo(r) {
            if (!r || !r.owner || !r.repo) return false;
            if (repoList.length >= MAX_REPOS) {
                flashHint('最多 ' + MAX_REPOS + ' 个仓库');
                return false;
            }
            const dup = repoList.some(x =>
                x.owner.toLowerCase() === r.owner.toLowerCase() &&
                x.repo.toLowerCase() === r.repo.toLowerCase()
            );
            if (dup) {
                flashHint(r.owner + '/' + r.repo + ' 已经在列表里');
                return false;
            }
            const defBranch = (panel.querySelector('input[data-k="branch"]').value || '').trim() || 'main';
            repoList.push({
                owner: r.owner,
                repo: r.repo,
                branch: r.branch || defBranch
            });
            renderRepos();
            return true;
        }

        const fill = (src) => {
            panel.querySelectorAll('input[data-k]').forEach(inp => {
                if (inp.dataset.k === 'forums') return;
                inp.value = src[inp.dataset.k] || '';
            });
            repoList = (src.repos || []).map(r => ({
                owner: r.owner,
                repo: r.repo,
                branch: r.branch || src.branch || 'main'
            }));
            renderRepos();

            forumTags = String(src.forums || '')
                .split(/[\n,，、\s]+/)
                .map(x => x.trim().toLowerCase())
                .filter(Boolean);
            renderForums();
        };
        fill(CONF);

        // 粘贴仓库地址，回车导入
        const importInp = panel.querySelector('input[data-import]');
        importInp.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const r = parseRepo(importInp.value);
            if (!r) {
                flashHint('看不懂这个地址，试试 用户名/仓库');
                return;
            }
            if (addRepo(r)) {
                importInp.value = '';
                flashHint('已加入 ' + r.owner + '/' + r.repo + '，记得点保存');
            }
        });
        importInp.addEventListener('blur', () => {
            if (!importInp.value.trim()) return;
            const r = parseRepo(importInp.value);
            if (r && addRepo(r)) importInp.value = '';
        });

        // 回车（或逗号）确认一个吧名，退格删掉最后一个
        const fInp = panel.querySelector('input[data-k="forums"]');
        fInp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === '、') {
                e.preventDefault();
                const v = fInp.value.trim().toLowerCase();
                if (v && !forumTags.includes(v)) forumTags.push(v);
                fInp.value = '';
                renderForums();
            } else if (e.key === 'Backspace' && !fInp.value && forumTags.length) {
                forumTags.pop();
                renderForums();
            }
        });
        fInp.addEventListener('blur', () => {
            const v = fInp.value.trim().toLowerCase();
            if (v && !forumTags.includes(v)) {
                forumTags.push(v);
                fInp.value = '';
                renderForums();
            }
        });

        gear.addEventListener('click', () => {
            panel.classList.toggle('on');
        });

        panel.querySelector('[data-act="reset"]').addEventListener('click', () => {
            fill(DEFAULT_CONF);
        });

        panel.querySelector('[data-act="save"]').addEventListener('click', () => {
            if (!repoList.length) {
                alert('先导入至少一个仓库');
                return;
            }
            const next = { repos: repoList };
            panel.querySelectorAll('input[data-k]').forEach(inp => {
                if (inp.dataset.k === 'forums') return;
                next[inp.dataset.k] = inp.value.trim();
            });
            if (!next.branch) next.branch = 'main';

            const pending = fInp.value.trim().toLowerCase();
            if (pending && !forumTags.includes(pending)) forumTags.push(pending);
            next.forums = forumTags.join('\n');

            try {
                localStorage.setItem(CONF_KEY, JSON.stringify(next));
            } catch (e) {
                alert('保存失败，浏览器可能禁止了本地存储');
                return;
            }
            location.reload();
        });

        panel.querySelector('[data-act="reload"]').addEventListener('click', () => {
            CONF.repos.forEach(r => {
                try { localStorage.removeItem(cacheKey(r)); } catch (e) {}
            });
            loadIndex(true);
        });

        document.body.appendChild(panel);
        document.body.appendChild(gear);

        paintStatus();
        paintGear();
    }

    // ---------- 预览弹窗 ----------
    const PREVIEW_CACHE = new Map();
    const PREVIEW_MAX_TEXT = 2 * 1024 * 1024;

    function rawUrl(f) {
        const encoded = String(f.name).split('/').map(encodeURIComponent).join('/');
        const p = (CONF.prefix || '').trim();
        if (p) {
            return p.replace(/\/+$/, '') + '/'
                .replace(/\{owner\}/g, f.owner)
                .replace(/\{repo\}/g, f.repo)
                .replace(/\{branch\}/g, f.branch) + encoded;
        }
        return `https://raw.githubusercontent.com/${f.owner}/${f.repo}/${f.branch}/${encoded}`;
    }

    // 只有文本类才走弹窗预览，其它类型直接开原链接
    function previewKind(name) {
        const ext = (String(name).split('.').pop() || '').toLowerCase();
        if (ext === 'md' || ext === 'markdown') return 'md';
        if (/^(txt|json|js|mjs|cjs|ts|tsx|jsx|css|scss|less|html|htm|xml|yml|yaml|csv|tsv|log|ini|conf|cfg|sh|bat|ps1|py|go|java|c|h|cpp|cs|rs|rb|php|sql|toml|env|gitignore)$/.test(ext)) return 'text';
        return '';
    }

    function pvEsc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // 行内元素：先抽出行内代码，再处理链接、加粗、斜体、删除线
    function pvInline(src) {
        let t = pvEsc(src);
        const codes = [];
        t = t.replace(/`([^`]+)`/g, (m, c) => {
            codes.push(c);
            return '\u0001' + (codes.length - 1) + '\u0001';
        });

        t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, url) => {
            const u = url.trim();
            if (!/^(https?:\/\/|#|\/|\.\/|\.\.\/)/i.test(u)) return txt;
            return '<a href="' + pvEsc(u) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>';
        });

        t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
        t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        t = t.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + codes[+i] + '</code>');
        return t;
    }

    function pvSplitRow(line) {
        return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim());
    }

    // 极简 markdown 渲染。所有原文先转义，不解析原始 HTML。
    function renderMarkdown(src) {
        const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            // 代码块
            if (/^```/.test(line)) {
                const buf = [];
                i++;
                while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
                i++;
                out.push('<pre><code>' + pvEsc(buf.join('\n')) + '</code></pre>');
                continue;
            }

            if (!line.trim()) { i++; continue; }

            // 分隔线
            if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

            // 标题
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                const lv = h[1].length;
                out.push('<h' + lv + '>' + pvInline(h[2]) + '</h' + lv + '>');
                i++;
                continue;
            }

            // 引用
            if (/^>\s?/.test(line)) {
                const buf = [];
                while (i < lines.length && /^>\s?/.test(lines[i])) {
                    buf.push(lines[i].replace(/^>\s?/, ''));
                    i++;
                }
                out.push('<blockquote>' + renderMarkdown(buf.join('\n')) + '</blockquote>');
                continue;
            }

            // 表格（当前行含 | 且下一行是分隔行）
            if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1])) {
                const head = pvSplitRow(line);
                i += 2;
                const rows = [];
                while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
                    rows.push(pvSplitRow(lines[i]));
                    i++;
                }
                let html = '<table><thead><tr>' + head.map(c => '<th>' + pvInline(c) + '</th>').join('') + '</tr></thead><tbody>';
                rows.forEach(r => {
                    html += '<tr>' + head.map((_, k) => '<td>' + pvInline(r[k] || '') + '</td>').join('') + '</tr>';
                });
                html += '</tbody></table>';
                out.push(html);
                continue;
            }

            // 列表
            if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
                const ordered = /^\s*\d+\./.test(line);
                const items = [];
                while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
                    i++;
                }
                const tag = ordered ? 'ol' : 'ul';
                out.push('<' + tag + '>' + items.map(t => '<li>' + pvInline(t) + '</li>').join('') + '</' + tag + '>');
                continue;
            }

            // 段落
            const buf = [];
            while (
                i < lines.length &&
                lines[i].trim() &&
                !/^```/.test(lines[i]) &&
                !/^#{1,6}\s/.test(lines[i]) &&
                !/^>\s?/.test(lines[i]) &&
                !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
                !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
            ) {
                buf.push(lines[i]);
                i++;
            }
            if (buf.length) {
                out.push('<p>' + pvInline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
            } else {
                i++;
            }
        }

        return out.join('\n');
    }

    function ensurePreview() {
        let mask = document.querySelector('.gg-pv-mask');
        if (mask) return mask;

        const style = document.createElement('style');
        style.textContent = [
            '.gg-pv-mask{position:fixed;inset:0;z-index:2147483600;background:rgba(15,25,40,.45);display:none;align-items:center;justify-content:center;padding:24px}',
            '.gg-pv-mask.on{display:flex}',
            '.gg-pv{background:#fff;border-radius:12px;box-shadow:0 18px 56px rgba(10,25,45,.32);width:100%;max-width:880px;min-height:260px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
            '.gg-pv-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #e8eef5;flex:0 0 auto}',
            '.gg-pv-title{font-size:13px;color:#22384f;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}',
            '.gg-pv-gap{flex:1 1 auto}',
            '.gg-pv-tag{flex:0 0 auto;font-size:11px;color:#7b8ea6;background:#f1f5fa;border-radius:4px;padding:1px 6px}',
            '.gg-pv-acts{flex:0 0 auto;display:flex;align-items:center;gap:6px}',
            '.gg-pv-acts button,.gg-pv-acts a{font-size:12px;font-family:inherit;padding:3px 8px;border:1px solid #d5dfea;border-radius:6px;background:#fff;color:#5a7086;cursor:pointer;text-decoration:none;line-height:1.5}',
            '.gg-pv-acts button:hover,.gg-pv-acts a:hover{background:#f5f8fc;border-color:#b9c8d9}',
            '.gg-pv-acts [data-pv="close"]{font-size:16px;padding:0 8px;line-height:1.3}',
            '.gg-pv-body{flex:1 1 auto;overflow:auto;padding:16px 18px;font-size:14px;line-height:1.7;color:#2d3f52}',
            '.gg-pv-body img{max-width:100%;height:auto;display:block;margin:0 auto}',
            '.gg-pv-frame{width:100%;height:62vh;border:0}',
            '.gg-pv-plain{margin:0;font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:#2d3f52}',
            '.gg-pv-msg{padding:28px 0;text-align:center;color:#8b9bb0;font-size:13px;line-height:1.8}',
            '.gg-pv-msg.err{color:#c0443f}',
            '.gg-pv-md h1,.gg-pv-md h2,.gg-pv-md h3{margin:1.1em 0 .5em;line-height:1.35;color:#1f3550}',
            '.gg-pv-md h1{font-size:1.5em;border-bottom:1px solid #e8eef5;padding-bottom:.3em}',
            '.gg-pv-md h2{font-size:1.25em;border-bottom:1px solid #eef3f8;padding-bottom:.25em}',
            '.gg-pv-md h3{font-size:1.08em}',
            '.gg-pv-md p{margin:.7em 0}',
            '.gg-pv-md ul,.gg-pv-md ol{margin:.6em 0;padding-left:1.6em}',
            '.gg-pv-md li{margin:.25em 0}',
            '.gg-pv-md code{background:#f1f5fa;padding:1px 4px;border-radius:3px;font-family:Consolas,Menlo,monospace;font-size:.9em;color:#b5425f}',
            '.gg-pv-md pre{background:#f6f8fb;border:1px solid #e8eef5;border-radius:8px;padding:11px 13px;overflow:auto;margin:.8em 0}',
            '.gg-pv-md pre code{background:none;padding:0;color:#2d3f52;font-size:12.5px;line-height:1.6}',
            '.gg-pv-md blockquote{margin:.8em 0;padding:.2em 0 .2em 12px;border-left:3px solid #d5dfea;color:#63788f}',
            '.gg-pv-md table{border-collapse:collapse;margin:.8em 0;font-size:13px;display:block;overflow:auto}',
            '.gg-pv-md th,.gg-pv-md td{border:1px solid #e2eaf3;padding:6px 10px;text-align:left}',
            '.gg-pv-md th{background:#f6f8fb;font-weight:600}',
            '.gg-pv-md hr{border:0;border-top:1px solid #e8eef5;margin:1.2em 0}',
            '.gg-pv-md a{color:#2f7bd4;text-decoration:none}',
            '.gg-pv-md a:hover{text-decoration:underline}'
        ].join('\n');
        document.head.appendChild(style);

        mask = document.createElement('div');
        mask.className = 'gg-pv-mask';
        mask.setAttribute('data-gg-skip', '1');
        mask.innerHTML = [
            '<div class="gg-pv">',
            '<div class="gg-pv-head">',
            '<span class="gg-pv-title"></span>',
            '<span class="gg-pv-tag"></span>',
            '<span class="gg-pv-gap"></span>',
            '<div class="gg-pv-acts">',
            '<button type="button" data-pv="mode" style="display:none"></button>',
            '<a data-pv="open" target="_blank" rel="noopener noreferrer">新标签打开</a>',
            '<button type="button" data-pv="close" title="关闭">\u00d7</button>',
            '</div>',
            '</div>',
            '<div class="gg-pv-body"></div>',
            '</div>'
        ].join('');

        mask.addEventListener('click', (e) => {
            if (e.target === mask) closePreview();
        });
        mask.querySelector('[data-pv="close"]').addEventListener('click', closePreview);

        document.body.appendChild(mask);
        return mask;
    }

    function closePreview() {
        const mask = document.querySelector('.gg-pv-mask');
        if (mask) mask.classList.remove('on');
    }

    let pvCurrent = null;

    function openPreview(f, href) {
        const mask = ensurePreview();
        const body = mask.querySelector('.gg-pv-body');
        const titleEl = mask.querySelector('.gg-pv-title');
        const tagEl = mask.querySelector('.gg-pv-tag');
        const modeBtn = mask.querySelector('[data-pv="mode"]');
        const openA = mask.querySelector('[data-pv="open"]');

        const kind = previewKind(f.name) || 'text';
        pvCurrent = { f: f, kind: kind };

        titleEl.textContent = f.name;
        titleEl.title = f.name;
        tagEl.textContent = kind;
        openA.href = href || rawUrl(f);

        modeBtn.style.display = kind === 'md' ? '' : 'none';
        modeBtn.textContent = mdRenderOn() ? '渲染' : '原文';

        mask.classList.add('on');
        body.innerHTML = '<div class="gg-pv-msg">加载中…</div>';

        const key = f.owner + '/' + f.repo + '/' + f.branch + '/' + f.name;
        const cached = PREVIEW_CACHE.get(key);
        if (cached !== undefined) {
            paintText(body, cached, kind);
            return;
        }

        fetch(rawUrl(f), { cache: 'no-store' })
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(t => {
                if (pvCurrent && pvCurrent.f.name !== f.name) return;   // 已经切到别的文件了
                if (t.length > PREVIEW_MAX_TEXT) {
                    body.innerHTML = '<div class="gg-pv-msg">文件太大了（' + Math.round(t.length / 1024) + ' KB），不适合在弹窗里预览。</div>';
                    return;
                }
                PREVIEW_CACHE.set(key, t);
                paintText(body, t, kind);
            })
            .catch(e => {
                if (pvCurrent && pvCurrent.f.name !== f.name) return;
                body.innerHTML = '<div class="gg-pv-msg err">读取失败：' + pvEsc(e.message) + '<br>可能是网络问题，或者仓库不是公开的。</div>';
            });
    }

    function paintText(body, text, kind) {
        if (kind === 'md' && mdRenderOn()) {
            body.innerHTML = '<div class="gg-pv-md">' + renderMarkdown(text) + '</div>';
            return;
        }
        const pre = document.createElement('pre');
        pre.className = 'gg-pv-plain';
        pre.textContent = text;
        body.innerHTML = '';
        body.appendChild(pre);
    }

    function refreshPreview() {
        if (!pvCurrent) return;
        const mask = document.querySelector('.gg-pv-mask');
        if (!mask || !mask.classList.contains('on')) return;
        const body = mask.querySelector('.gg-pv-body');
        const modeBtn = mask.querySelector('[data-pv="mode"]');
        modeBtn.textContent = mdRenderOn() ? '渲染' : '原文';
        if (pvCurrent.kind !== 'md') return;
        const key = pvCurrent.f.owner + '/' + pvCurrent.f.repo + '/' + pvCurrent.f.branch + '/' + pvCurrent.f.name;
        const t = PREVIEW_CACHE.get(key);
        if (t !== undefined) paintText(body, t, 'md');
    }

    function scan(root) {
        if (!root) return;
        processElement(root);
    }

    // 切换模式后，把页面上已经生成的链接重新算一遍地址
    function refreshLinks() {
        document.querySelectorAll('a[data-file]').forEach(a => {
            const parts = (a.dataset.repo || '').split('/');
            if (parts.length < 3) return;
            const f = {
                name: a.dataset.file,
                owner: parts[0],
                repo: parts[1],
                branch: parts.slice(2).join('/')
            };
            a.href = fileUrl(f);
            a.title = a.href;
        });
    }

    // 所有按钮的文字跟着当前模式走
    function syncToggles() {
        const on = mdRenderOn();
        document.querySelectorAll('button[data-md-toggle]').forEach(b => {
            b.textContent = on ? '渲染' : '原文';
            b.title = on
                ? '.md 打开后是排版好的网页，点这里改成纯文本'
                : '.md 打开后是纯文本源码，点这里改成排版网页';
        });
    }

    // 跟在 md 链接后面的小按钮
    function makeMdToggle() {
        const btn = document.createElement('button');
        btn.setAttribute('data-md-toggle', '1');
        btn.type = 'button';
        btn.style.cssText = [
            'display:inline-block', 'margin-left:4px', 'padding:0 4px',
            'font-size:10px', 'line-height:15px', 'vertical-align:1px',
            'border:1px solid #ccd6e4', 'border-radius:3px',
            'background:#f5f8fc', 'color:#6b86a6', 'cursor:pointer',
            'font-family:inherit', 'outline:none', 'white-space:nowrap'
        ].join(';');

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setMdRender(!mdRenderOn());
            refreshLinks();
            syncToggles();
            refreshPreview();
        });

        return btn;
    }

    // ---------- 索引 ----------
    // status: idle | loading | ok | stale | fail
    const INDEX_STATE = { status: 'idle', count: 0, msg: '' };

    function readCache(r, allowStale) {
        try {
            const c = JSON.parse(localStorage.getItem(cacheKey(r)) || 'null');
            if (!c || !Array.isArray(c.files)) return null;
            if (!allowStale && Date.now() - c.t >= CACHE_TTL) return null;
            return c.files;
        } catch (e) {}
        return null;
    }

    function writeCache(r, files) {
        try {
            localStorage.setItem(cacheKey(r), JSON.stringify({ t: Date.now(), files }));
        } catch (e) {}
    }

    function setIndexState(status, count, msg) {
        INDEX_STATE.status = status;
        INDEX_STATE.count = count || 0;
        INDEX_STATE.msg = msg || '';
        paintStatus();
        paintGear();
    }

    async function loadIndex(force) {
        const repos = CONF.repos.slice(0, MAX_REPOS);
        if (!repos.length) return;

        const all = [];
        const addFiles = (r, names) => {
            names.forEach(n => all.push({ name: n, owner: r.owner, repo: r.repo, branch: r.branch }));
        };

        // 先用各仓库的缓存（过期的也用），把能显示的立刻显示出来
        const missing = [];
        repos.forEach(r => {
            const fresh = force ? null : readCache(r, false);
            const usable = fresh || readCache(r, true);
            if (usable) addFiles(r, usable);
            if (!fresh) missing.push(r);
        });

        if (all.length) {
            buildIndex(all);
            scan(document.body);
            setIndexState('stale', all.length);
        } else {
            setIndexState('loading', 0);
        }

        if (!missing.length) {
            buildIndex(all);
            setIndexState('ok', all.length);
            return;
        }

        // 缺的（或强制刷新时）逐个去拉
        let failed = 0;
        let lastMsg = '';
        for (const r of missing) {
            try {
                const resp = await fetch(apiUrl(r), {
                    headers: { Accept: 'application/vnd.github+json' },
                    cache: 'no-store'
                });
                if (!resp.ok) {
                    failed++;
                    lastMsg = 'HTTP ' + resp.status + (resp.status === 403 || resp.status === 429 ? '（GitHub 限流）' : '');
                    continue;
                }
                const list = await resp.json();
                if (!Array.isArray(list)) {
                    failed++;
                    lastMsg = '返回格式不对，检查仓库名';
                    continue;
                }
                const names = list.filter(x => x.type === 'file').map(x => x.name);
                if (!names.length) {
                    failed++;
                    lastMsg = '仓库里没读到文件，检查分支名';
                    continue;
                }
                writeCache(r, names);
                addFiles(r, names);
            } catch (e) {
                failed++;
                lastMsg = '网络请求失败';
            }
        }

        buildIndex(all);
        scan(document.body);

        if (failed) {
            setIndexState('fail', all.length, failed + ' 个仓库读取失败：' + lastMsg);
        } else {
            setIndexState('ok', all.length);
        }
    }

    function init() {
        mountSettings();

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closePreview();
        });

        const pvMask = ensurePreview();
        pvMask.querySelector('[data-pv="mode"]').addEventListener('click', () => {
            setMdRender(!mdRenderOn());
            refreshLinks();
            syncToggles();
            refreshPreview();
        });

        // 齿轮和面板任何吧都显示，方便随时改配置

        if (!confReady()) return;      // 没填仓库，什么都不做
        if (!forumAllowed()) return;   // 不在配置的吧里，不处理

        // 先用缓存建索引，立刻扫一次
        const cached = readCache();
        if (cached) {
            buildIndex(cached);
            scan(document.body);
        }

        // 没缓存 / 过期了就去拉，拉到再扫一次
        loadIndex();

        new MutationObserver(mutations => {
            mutations.forEach(mu => {
                mu.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        processElement(node);
                    } else if (node.nodeType === Node.TEXT_NODE) {
                        try { processTextNode(node); } catch (e) {}
                    }
                });
            });
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
