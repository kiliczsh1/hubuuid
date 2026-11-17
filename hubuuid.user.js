// ==UserScript==
// @name         hubuuid
// @namespace    https://github.com/kiliczsh1/hubuuid
// @version      1.0.0
// @description  把贴吧里出现的 GitHub 仓库文件名，自动变成可点击的链接
// @author       kiliczsh1
// @match        https://tieba.baidu.com/f*
// @match        https://tieba.baidu.com/p/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ============ 配置区 ============
    // 默认值。页面右下角齿轮里可以改，改完存在你自己的浏览器里，不影响别人
    const DEFAULT_CONF = {
        owner: '',
        repo: '',
        branch: 'main',
        prefix: '',     // 留空 = 走 GitHub raw；填了就用这个前缀拼地址（比如换成加速镜像）
        forums: ''      // 只在哪些吧生效；留空 = 所有吧都生效
    };

    const CONF_KEY = 'gg_repo_conf_v1';

    let CONF = Object.assign({}, DEFAULT_CONF);
    try {
        const c = JSON.parse(localStorage.getItem(CONF_KEY) || 'null');
        if (c && c.owner && c.repo) CONF = Object.assign({}, DEFAULT_CONF, c);
    } catch (e) {}

    const confReady = () => !!(CONF.owner && CONF.repo);

    const baseUrl = () => {
        const p = (CONF.prefix || '').trim();
        if (p) return p.replace(/\/+$/, '') + '/';
        return `https://raw.githubusercontent.com/${CONF.owner}/${CONF.repo}/${CONF.branch}/`;
    };

    const apiUrl = () =>
        `https://api.github.com/repos/${CONF.owner}/${CONF.repo}/contents/?ref=${encodeURIComponent(CONF.branch)}`;

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

    const modeKey = () => `gg_md_mode_${CONF.owner}_${CONF.repo}`;

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
    // 生成文件地址：默认走 raw（直接给文件），md 可选走 GitHub 网页（渲染）
    function urlFor(name) {
        const encoded = name.split('/').map(encodeURIComponent).join('/');
        if (mdRenderOn() && /\.md$/i.test(name)) {
            return `https://github.com/${CONF.owner}/${CONF.repo}/blob/${CONF.branch}/${encoded}`;
        }
        return baseUrl() + encoded;
    }

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

    const cacheKey = () => `gg_repo_index_${CONF.owner}_${CONF.repo}_${CONF.branch}`;
    // ================================

    // 小写名 -> 仓库里的真实文件名
    let FILE_MAP = new Map();
    let NAME_RE = null;

    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function buildIndex(files) {
        FILE_MAP = new Map();

        // 同一个名字对应多个扩展名时（a.md / a.jpg），不带扩展名的写法有歧义，不收录
        const stemCount = new Map();
        files.forEach(f => {
            if (!f) return;
            const s = f.replace(/\.[^.]+$/, '').toLowerCase();
            stemCount.set(s, (stemCount.get(s) || 0) + 1);
        });

        files.forEach(f => {
            if (!f || BLACKLIST.includes(f.toLowerCase())) return;
            FILE_MAP.set(f.toLowerCase(), f);

            // 不带扩展名的写法也认：只对"够长、含数字、且唯一"的名字开，避免撞上普通英文单词
            const stem = f.replace(/\.[^.]+$/, '');
            const key = stem.toLowerCase();
            if (stem.length >= 8 && /\d/.test(stem) && stemCount.get(key) === 1) {
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
            const realName = FILE_MAP.get(match[0].toLowerCase());
            if (!realName) continue;

            hit = true;

            if (match.index > lastIndex) {
                fragments.push(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const end = eatNoise(text, NAME_RE.lastIndex);

            const a = document.createElement('a');
            a.href = urlFor(realName);
            a.dataset.file = realName;   // 记住真实文件名，切换模式时用来重算地址
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = a.href;
            a.textContent = match[0];   // 显示原样
            a.style.textDecoration = 'none';
            a.style.borderBottom = '1px dashed #4a90d9';
            a.style.marginRight = LINK_GAP;
            fragments.push(a);

            // md 文件在链接后面跟一个切换小按钮
            if (SHOW_TOGGLE && /\.md$/i.test(realName)) {
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
        wrapper.setAttribute('data-repo-link', '1');
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

            if (!prev) {
                if (head && couldBePrefix(head)) prev = n;
                return;   // "22分钟前""河南""赞""回复" 在这里就被挡掉了
            }

            const merged = prev.textContent + head;
            if (head && couldBePrefix(merged)) {
                prev.textContent = merged;
                if (rest) n.textContent = rest; else dead.push(n);
            } else {
                prev = null;
            }
        });
        dead.forEach(n => n.remove());
    }

    function processElement(el) {
        if (!el.tagName) return;
        if (/^(SCRIPT|STYLE|NOSCRIPT|A|TEXTAREA|INPUT|BUTTON)$/.test(el.tagName)) return;
        if (el.namespaceURI === 'http://www.w3.org/2000/svg') return;
        if (el.getAttribute && el.getAttribute('data-repo-link')) return;

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
        if (!confReady()) return '还没配置仓库，点齿轮填上用户名和仓库名';
        const forum = forumLabel();
        const s = INDEX_STATE;
        if (s.status === 'fail') return forum + ' ｜ 清单读取失败：' + s.msg;
        if (s.status === 'loading') return forum + ' ｜ 正在读取清单…';
        if (s.status === 'stale') return forum + ' ｜ 清单已过期，正在更新…';
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
        panel.setAttribute('data-repo-link', '1');
        panel.innerHTML = [
            '<h4>仓库设置</h4>',
            '<div class="gg-status" data-state="idle">正在识别当前吧…</div>',
            '<label><span>GitHub 用户名</span><input data-k="owner" placeholder="kiliczsh1"></label>',
            '<label><span>仓库名</span><input data-k="repo" placeholder="tuituit"></label>',
            '<label><span>分支</span><input data-k="branch" placeholder="main"></label>',
            '<label><span>生效的吧（回车确认，留空=全部）</span><div class="gg-tags"></div><input data-k="forums" placeholder="输入吧名，按回车添加"></label>',
            '<label><span>自定义前缀（可留空）</span><input data-k="prefix" placeholder="https://raw.githubusercontent.com/..."></label>',
            '<div class="gg-btns">',
            '<button data-act="reset" type="button">恢复默认</button>',
            '<button data-act="save" type="button">保存并刷新</button>',
            '</div>',
            '<div class="gg-btns"><button data-act="reload" type="button">重新读取文件清单</button></div>',
            '<div class="gg-hint">保存后页面会刷新。自定义前缀留空时，按上面的用户名/仓库/分支自动拼地址。</div>'
        ].join('');

        let forumTags = [];

        function renderTags() {
            const box = panel.querySelector('.gg-tags');
            box.innerHTML = '';
            forumTags.forEach((name, i) => {
                const t = document.createElement('span');
                t.className = 'gg-tag';
                t.textContent = name;
                const x = document.createElement('b');
                x.textContent = '\u00d7';
                x.title = '删掉这个吧';
                x.addEventListener('click', () => { forumTags.splice(i, 1); renderTags(); });
                t.appendChild(x);
                box.appendChild(t);
            });
            box.style.display = forumTags.length ? 'flex' : 'none';
        }

        function addTag(v) {
            const s = String(v || '').trim().toLowerCase();
            if (!s) return;
            if (!forumTags.includes(s)) forumTags.push(s);
            renderTags();
        }

        const fill = (src) => {
            panel.querySelectorAll('input,textarea').forEach(inp => {
                if (inp.dataset.k === 'forums') return;
                inp.value = src[inp.dataset.k] || '';
            });
            forumTags = String(src.forums || '')
                .split(/[\n,，、\s]+/)
                .map(x => x.trim().toLowerCase())
                .filter(Boolean);
            renderTags();
        };
        fill(CONF);

        // 回车（或逗号）确认一个吧名，退格删掉最后一个
        const fInp = panel.querySelector('input[data-k="forums"]');
        fInp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === '、') {
                e.preventDefault();
                addTag(fInp.value);
                fInp.value = '';
            } else if (e.key === 'Backspace' && !fInp.value && forumTags.length) {
                forumTags.pop();
                renderTags();
            }
        });
        fInp.addEventListener('blur', () => {
            if (fInp.value.trim()) { addTag(fInp.value); fInp.value = ''; }
        });

        gear.addEventListener('click', () => {
            panel.classList.toggle('on');
        });

        panel.querySelector('[data-act="reset"]').addEventListener('click', () => {
            fill(DEFAULT_CONF);
        });

        panel.querySelector('[data-act="save"]').addEventListener('click', () => {
            const next = {};
            panel.querySelectorAll('input,textarea').forEach(inp => {
                if (inp.dataset.k === 'forums') return;
                next[inp.dataset.k] = inp.value.trim();
            });
            const fInp = panel.querySelector('input[data-k="forums"]');
            addTag(fInp.value);          // 还没按回车的也收进去
            fInp.value = '';
            next.forums = forumTags.join('\n');
            if (!next.owner || !next.repo) {
                alert('用户名和仓库名不能为空');
                return;
            }
            if (!next.branch) next.branch = 'main';
            try {
                localStorage.setItem(CONF_KEY, JSON.stringify(next));
            } catch (e) {
                alert('保存失败，浏览器可能禁止了本地存储');
                return;
            }
            location.reload();
        });

        panel.querySelector('[data-act="reload"]').addEventListener('click', () => {
            try { localStorage.removeItem(cacheKey()); } catch (e) {}
            loadIndex(true);
        });

        document.body.appendChild(panel);
        document.body.appendChild(gear);

        paintStatus();
        paintGear();
    }

    function scan(root) {
        if (!root) return;
        processElement(root);
    }

    // 切换模式后，把页面上已经生成的链接重新算一遍地址
    function refreshLinks() {
        document.querySelectorAll('a[data-file]').forEach(a => {
            a.href = urlFor(a.dataset.file);
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
        });

        return btn;
    }

    // ---------- 索引 ----------
    // status: idle | loading | ok | stale | fail
    const INDEX_STATE = { status: 'idle', count: 0, msg: '' };

    function readCache(allowStale) {
        try {
            const c = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
            if (!c || !Array.isArray(c.files)) return null;
            if (!allowStale && Date.now() - c.t >= CACHE_TTL) return null;
            return c.files;
        } catch (e) {}
        return null;
    }

    function writeCache(files) {
        try {
            localStorage.setItem(cacheKey(), JSON.stringify({ t: Date.now(), files }));
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
        const fresh = force ? null : readCache(false);
        if (fresh) {
            buildIndex(fresh);
            setIndexState('ok', fresh.length);
            scan(document.body);
            return;
        }

        // 过期的也先拿来用，总比什么都不做强
        const stale = readCache(true);
        if (stale) {
            buildIndex(stale);
            setIndexState('stale', stale.length);
            scan(document.body);
        } else {
            setIndexState('loading', 0);
        }

        try {
            const resp = await fetch(apiUrl(), {
                headers: { Accept: 'application/vnd.github+json' },
                cache: 'no-store'
            });
            if (!resp.ok) {
                setIndexState('fail', 0, 'HTTP ' + resp.status + (resp.status === 403 || resp.status === 429 ? '（GitHub 限流，等下再试）' : ''));
                return;
            }
            const list = await resp.json();
            if (!Array.isArray(list)) {
                setIndexState('fail', 0, '返回格式不对，检查用户名/仓库名');
                return;
            }

            const files = list.filter(x => x.type === 'file').map(x => x.name);
            if (!files.length) {
                setIndexState('fail', 0, '仓库里没读到文件，检查分支名');
                return;
            }

            writeCache(files);
            buildIndex(files);
            setIndexState('ok', files.length);
            scan(document.body);   // 清单到手，重扫一遍
        } catch (e) {
            setIndexState('fail', 0, '网络请求失败，检查网络或前缀');
        }
    }

    function init() {
        mountSettings();   // 齿轮和面板任何吧都显示，方便随时改配置

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
