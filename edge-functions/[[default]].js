const SOURCE_URL = "https://im-imgs-bucket.oss-accelerate.aliyuncs.com/index.js?t_5";
const PLAY_BASE_URL = "https://play.sportsteam53.com"; 
const TARGET_KEY = "ABCDEFGHIJKLMNOPQRSTUVWX";
const KV_CACHE_KEY = "JRS_MATCHES_DATA";

// ==========================================
// XXTEA 加解密 
// ==========================================
function str2long(s) {
    let v = [];
    for (let i = 0; i < s.length; i += 4) {
        let val = s.charCodeAt(i);
        if (i + 1 < s.length) val |= s.charCodeAt(i + 1) << 8;
        if (i + 2 < s.length) val |= s.charCodeAt(i + 2) << 16;
        if (i + 3 < s.length) val |= s.charCodeAt(i + 3) << 24;
        v.push(val >>> 0); 
    }
    return v;
}

function long2str(v) {
    let s = "";
    for (let i = 0; i < v.length; i++) {
        s += String.fromCharCode(v[i] & 0xff);
        s += String.fromCharCode((v[i] >>> 8) & 0xff);
        s += String.fromCharCode((v[i] >>> 16) & 0xff);
        s += String.fromCharCode((v[i] >>> 24) & 0xff);
    }
    return s;
}

function xxtea_decrypt(data, key) {
    if (!data) return "";
    let v = str2long(data);
    let k = str2long(key);
    while (k.length < 4) k.push(0);
    let n = v.length - 1;
    if (n < 1) return "";
    let z = v[n], y = v[0], delta = 0x9E3779B9;
    let q = Math.floor(6 + 52 / (n + 1));
    let sum = (q * delta) >>> 0;
    while (sum !== 0) {
        let e = (sum >>> 2) & 3;
        for (let p = n; p > 0; p--) {
            z = v[p - 1];
            let mx = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p & 3) ^ e] ^ z));
            y = v[p] = (v[p] - mx) >>> 0;
        }
        let p = 0;
        z = v[n];
        let mx = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p & 3) ^ e] ^ z));
        y = v[0] = (v[0] - mx) >>> 0;
        sum = (sum - delta) >>> 0;
    }
    let m = v[v.length - 1];
    let limit = (v.length - 1) << 2;
    if (m < limit - 3 || m > limit) return null;
    return long2str(v).substring(0, m);
}

function decrypt_id_to_url_v2(encrypted_id) {
    try {
        let decoded_id = decodeURIComponent(encrypted_id).trim();
        let pad = 4 - (decoded_id.length % 4);
        if (pad !== 4) decoded_id += "=".repeat(pad);
        
        let bin_str = atob(decoded_id); 
        let decrypted_bin = xxtea_decrypt(bin_str, TARGET_KEY);
        
        if (!decrypted_bin) {
            return { success: false, reason: "XXTEA底层解密失败(返回null)，密钥几乎100%已变更", raw: "" };
        }

        let bytes = new Uint8Array(decrypted_bin.length);
        for (let i = 0; i < decrypted_bin.length; i++) {
            bytes[i] = decrypted_bin.charCodeAt(i);
        }
        let utf8_str = new TextDecoder('utf-8').decode(bytes);
        
        try {
            let json_obj = JSON.parse(utf8_str);
            if (json_obj && json_obj.url) return { success: true, url: json_obj.url };
        } catch (e) {
            let matchUrl = utf8_str.match(/(https?:[\/\\]+[^\s"'<>]+)/i);
            if (matchUrl) return { success: true, url: matchUrl[1].replace(/\\/g, '') };
        }
        
        return { success: false, reason: "解密成功但未能找到URL", raw: utf8_str };
    } catch (e) {
        return { success: false, reason: "代码执行异常: " + e.message, raw: "" };
    }
}

async function safeFetch(url, customHeaders = {}) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        ...customHeaders
    };
    try {
        return await fetch(url, { headers });
    } catch (e) {
        return null;
    }
}

function getValidMatchTimestamp(timeStr) {
    if (!timeStr) return null;
    let now = new Date();
    let utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    let bjNow = new Date(utc + (3600000 * 8)); 
    let currentYear = bjNow.getFullYear();
    let parts = timeStr.split(' ');
    if (parts.length !== 2) return null;
    let [month, day] = parts[0].split('-');
    let [hour, min] = parts[1].split(':');
    let matchDt = new Date(currentYear, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min));
    if ((matchDt - bjNow) / (1000 * 3600 * 24) > 180) {
        matchDt.setFullYear(currentYear - 1);
    }
    let diffHours = (matchDt - bjNow) / (1000 * 3600);
    if (diffHours >= -3.5 && diffHours <= 0.5) return matchDt.getTime(); 
    return null;
}

// ==========================================
// 核心任务：并发爬取源站数据（优化边缘函数超时问题）
// ==========================================
async function scrapeAndExtractMatches() {
    let jsRes = await safeFetch(SOURCE_URL, { "Referer": "https://www.jrsyyds.com/" });
    if (!jsRes || !jsRes.ok) throw new Error("主线路获取失败，可能是源站拦截。");
    let jsText = await jsRes.text();
    
    let blocks = jsText.split('<ul class="item play');
    blocks.shift(); 

    // 1. 筛选出符合时间条件的比赛任务（上限 35 个，避免触发边缘函数子请求上限）
    let tasks = [];
    for (let block of blocks) {
        let timeMatch = block.match(/class="lab_time"[^>]*>([\s\S]*?)<\/li>/);
        if (!timeMatch) continue;
        let timeRaw = timeMatch[1].trim();

        let matchTs = getValidMatchTimestamp(timeRaw);
        if (!matchTs) continue;

        let eventsMatch = block.match(/class="lab_events"[^>]*>[\s\S]*?<span class="name">([^<]+)<\/span>/);
        let leagueName = eventsMatch ? eventsMatch[1].trim() : "综合";
        let homeMatch = block.match(/class="lab_team_home"[^>]*>[\s\S]*?<strong class="name">([^<]+)<\/strong>/);
        let awayMatch = block.match(/class="lab_team_away"[^>]*>[\s\S]*?<strong class="name">([^<]+)<\/strong>/);
        let homeTeam = homeMatch ? homeMatch[1].trim() : "Home";
        let awayTeam = awayMatch ? awayMatch[1].trim() : "Away";
        let idMatch = block.match(/getPlayUrl\(['"][^'"]+['"]\s*,\s*['"](\d+)['"]\)/);
        if (!idMatch) continue; 
        
        tasks.push({
            timeRaw,
            matchTs,
            leagueName,
            homeTeam,
            awayTeam,
            streamId: idMatch[1]
        });

        if (tasks.length >= 35) break;
    }

    // 2. 并发拉取详情页（避免串行阻塞超时）
    let finalEntries = [];
    const results = await Promise.all(tasks.map(async (task) => {
        let targetLink = `${PLAY_BASE_URL}/play/steam${task.streamId}.html`;
        let detailRes = await safeFetch(targetLink, { "Referer": PLAY_BASE_URL });
        if (!detailRes) return [];
        let detailHtml = await detailRes.text();

        let aPlays = [...detailHtml.matchAll(/<a[^>]+data-play="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
        let streamIndex = 1; 
        let entries = [];

        for (let a of aPlays) {
            let path = a[1];
            let quality = a[2].replace(/<[^>]+>/g, '').trim();

            if (quality.includes('高清') || quality.includes('蓝光') || quality.includes('原画')) {
                let pureQuality = quality.replace(/\s*(线路|[Mm])?[①②③④⑤⑥⑦⑧⑨⑩0-9]+$/g, '').trim();
                let timeOnly = task.timeRaw.includes(' ') ? task.timeRaw.split(' ')[1] : task.timeRaw;
                const circleNums = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
                let circleSymbol = circleNums[streamIndex - 1] || `(${streamIndex})`; let specificChannelName = `[${timeOnly}] ${task.leagueName}${task.homeTeam} VS ${task.awayTeam}${pureQuality}M${circleSymbol}`; streamIndex++;  let finalUrl = new URL(path, targetLink); let pathSegments = finalUrl.pathname.split('/'); let playType = pathSegments[pathSegments.length - 2] \vert{}\vert{} pathSegments[pathSegments.length - 1]; let qId = finalUrl.searchParams.get('id') \vert{}\vert{} ''; let qId2 = finalUrl.searchParams.get('id2') \vert{}\vert{} '';  entries.push({ group_name: "JRS线路", channel_name: specificChannelName, play_type: playType, q_id: qId, q_id2: qId2, match_ts: task.matchTs }); } } return entries; }));  for (let group of results) { finalEntries.push(...group); }  finalEntries.sort((a, b) => b.match_ts - a.match_ts); return finalEntries; }  // ========================================== // 写入 EdgeOne KV 存储（替代原 D1 数据库） // ========================================== async function updateKVStorage(kv) { try { if (!kv) throw new Error("未绑定 KV 命名空间，请在 EdgeOne Pages 控制台绑定变量名 JRS_KV"); const matches = await scrapeAndExtractMatches();  let payload = matches; if (matches.length === 0) { payload = [{ group_name: "系统提示", channel_name: "当前时间段无可用直播", play_type: "none", q_id: "", q_id2: "", match_ts: 0 }]; }  const storageObj = { updated_at: Date.now(), data: payload };  await kv.put(KV_CACHE_KEY, JSON.stringify(storageObj)); return { success: true, count: matches.length, data: payload }; } catch (e) { return { success: false, error: e.message }; } }  // ========================================== // EdgeOne Pages Functions 主入口 // ========================================== export async function onRequest(context) { const { request, env, waitUntil } = context; const url = new URL(request.url); const path = url.pathname; const workerOrigin = url.origin;  // 获取绑定的 KV 实例（兼容 env.JRS_KV 或全局 JRS_KV） const kv = (env && env.JRS_KV) \vert{}\vert{} (typeof JRS_KV !== 'undefined' ? JRS_KV : null);  // ========================== // 1. 直播请求实时解密代理 // ========================== if (path.startsWith('/live/')) { const playType = path.replace('/live/', '').replace('/', ''); const id = url.searchParams.get('id') \vert{}\vert{} ''; const id2 = url.searchParams.get('id2') \vert{}\vert{} '';  if (!playType \vert{}\vert{} !id \vert{}\vert{} playType === 'none') { return new Response("Missing target parameters", { status: 400 }); }  const targetUrl = `${PLAY_BASE_URL}/play/${playType}/?id=${id}${id2 ? `&id2=${id2}` : ''}`; try { let streamRes = await safeFetch(targetUrl, { "Referer": PLAY_BASE_URL }); if (!streamRes) return new Response("Error 502: Edge fetch blocked", { status: 502 });  let streamHtml = await streamRes.text(); let encryptedStr = null;  let m1 = streamHtml.match(/encodedStr\s*=\s*["']([^"']+)["']/i); let m2 = streamHtml.match(/"en_str"\s*:\s*["']([^"']+)["']/i);  if (m1) encryptedStr = m1[1]; else if (m2) encryptedStr = m2[1];  if (!encryptedStr) { return new Response(`[提取失败] 找不到密文。\n\n网页源码前段:\n${streamHtml.substring(0, 1000)}`, { status: 404, headers: {"Content-Type": "text/plain; charset=utf-8"} });
            }

            let localDecrypted = decrypt_id_to_url_v2(encryptedStr);

            if (localDecrypted.success) {
                let finalUrl = localDecrypted.url;
                if (finalUrl.startsWith('//')) finalUrl = 'https:' + finalUrl;
                return Response.redirect(finalUrl, 302);
            } else {
                return new Response(`[解密彻底失败]\n原因: ${localDecrypted.reason}\n解密出的明文: ${localDecrypted.raw}\n提取的密文: ${encryptedStr}`, { status: 500, headers: {"Content-Type": "text/plain; charset=utf-8"} }); }  } catch (e) { return new Response("Proxy error: " + e.message, { status: 500 }); } }  // ========================== // 2. 手动或外部 Cron 触发更新 // ========================== if (path === '/update') { const res = await updateKVStorage(kv); if (res.success) { return new Response(`抓取并入库成功！共写入 ${res.count} 条数据。`, { headers: {"Content-Type": "text/plain; charset=utf-8"} });
        } else {
            return new Response(`抓取失败: ${res.error}`, { status: 500, headers: {"Content-Type": "text/plain; charset=utf-8"} }); } }  // ========================== // 3. 从 KV 读取 M3U / TXT（含自动懒更新） // ========================== let formatType = ''; if (path === '/m3u' \vert{}\vert{} path === '/playlist.m3u') formatType = 'm3u'; if (path === '/txt' \vert{}\vert{} path === '/playlist.txt') formatType = 'txt';  if (formatType) { if (!kv) { return new Response("未配置 KV 存储，请先在控制台绑定 JRS_KV", { status: 500, headers: {"Content-Type": "text/plain; charset=utf-8"} }); }  let rawCache = await kv.get(KV_CACHE_KEY); let results = null;  if (rawCache) { try { const parsed = JSON.parse(rawCache); results = parsed.data; // 如果距离上次更新超过 15 分钟，后台异步触发一次静默更新 if (Date.now() - parsed.updated_at > 15 * 60 * 1000 && waitUntil) { waitUntil(updateKVStorage(kv)); } } catch (e) { results = null; } }  // 如果 KV 为空，首次访问直接同步抓取一次 if (!results \vert{}\vert{} results.length === 0) { const initRes = await updateKVStorage(kv); if (!initRes.success) { return new Response(`初始化抓取失败: ${initRes.error}`, { status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"} });
            }
            results = initRes.data;
        }

        let m3uLines = ["\uFEFF#EXTM3U"];
        let txtDict = {};

        for (let row of results) {
            if (row.play_type === 'none') {
                m3uLines.push(`#EXTINF:-1 tvg-id="" tvg-name="${row.channel_name}" tvg-logo="" group-title="${row.group_name}",${row.channel_name}`); m3uLines.push("http://127.0.0.1/error.mp4"); txtDict[row.group_name] = [`${row.channel_name},http://127.0.0.1/error.mp4`];
                continue;
            }

            let proxyUrl = `${workerOrigin}/live/${row.play_type}?id=${row.q_id}`; if (row.q_id2) proxyUrl += `&id2=${row.q_id2}`;

            m3uLines.push(`#EXTINF:-1 tvg-id="" tvg-name="${row.channel_name}" tvg-logo="" group-title="${row.group_name}",${row.channel_name}`); m3uLines.push(proxyUrl);  if (!txtDict[row.group_name]) txtDict[row.group_name] = []; txtDict[row.group_name].push(`${row.channel_name},${proxyUrl}`); }  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" };  if (formatType === 'm3u') { return new Response(m3uLines.join("\r\n"), { headers: { ...headers, "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8", "Content-Disposition": "attachment; filename=\"playlist.m3u\"" } }); } else { let txtLines = []; for (let group in txtDict) { txtLines.push(`${group},#genre#`);
                txtLines.push(...txtDict[group]);
            }
            return new Response(txtLines.join("\r\n"), {
                headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" }
            });
        }
    }

    return new Response("Service OK. Use /m3u, /txt or /update", { status: 200 });
}
