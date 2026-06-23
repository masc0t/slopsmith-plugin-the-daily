// Daily Setlist plugin

var _dsData = null;        // last /today response
var _dsLbDate = null;   // currently selected leaderboard date (YYYY-MM-DD)
var _dsSigned = false;     // whether user signed today
var _dsSigning = false;    // in-flight guard for sign submit
var _dsConfettiDoneFor = null; // date string; confetti has played for this date in this session
var _dsRating = null;      // selected rating: -1, 1, or null
var _dsReturnAfterPlayback = false;
var _dsReturnListenerRegistered = false;
var _dsInCompleteView = false; // true when Day Complete view is active
var _dsLastHistoricalRetryDate = null; // last date attempted for historical retry
var _dsActiveTab = 'today'; // 'today' or 'wof'
var _dsWofRoom = null;     // WoF Room scene instance
var _dsArchiveRoom = null; // Archive antechamber scene instance
var _dsHallOfRecords = null; // Hall of Records scene instance
var _dsShopRoom = null;      // Shop Room scene instance
var _dsWofLoaded = false;  // whether wall of fame data has been loaded
var _dsPlayStartTime = 0;   // when current song started playing
var _dsPlayingCfId = null;   // cf_id of song currently being played
var _dsPlayingNodeId = null; // map node currently being played
var _dsSkipNextInit = false;
var _dsInitialized = false; // whether dsInit has run at least once
var _dsBossJustCompleted = false; // triggers beat-1 dungeon celebration on next init
var _dsRoomJustCleared = null;    // node id whose exits should unseal on the next dungeon build (song-cleared rooms)
var _dsPendingBossStreak = 0; // streak number for boss-complete celebration
var _dsHistoricalDate = null;   // non-null when playing a historical dungeon (the date string)
var _dsTodaySnapshot = null;    // copy of _dsData saved before loading a historical day
var _dsHubEscConfirmed = false; // first Esc in Hub shows prompt, subsequent exits immediately
var _dsOrigShowScreen = null;   // original window.showScreen before plugin wrapped it


// Node type to icon mapping (centralized for visual consistency)
const NODE_TYPE_ICONS = {
    "forced": "🎸",
    "elite": "⚔️",
    "treasure": "💎",
    "rest": "🛌",
    "shop": "🏪",
    "mystery": "?",
    "choice": "◇",
    "boss": "👑",
};

// Minimap node colors keyed by type. State (locked/available/cleared/current)
// is conveyed separately via opacity + ring, so the dot's hue always tells you
// *what* a room is — the STS convention — instead of overloading fill with state.
const _DS_MAP_TYPE_COLORS = {
    boss: '#e0484c', elite: '#e07a30', shop: '#9b59ff', rest: '#3fae8a',
    treasure: '#e8c040', mystery: '#9aa0a8', choice: '#5a9bff',
    event: '#7aa0c0', forced: '#c9b07a', song: '#c9b07a',
};
function _dsMapNodeColor(type) { return _DS_MAP_TYPE_COLORS[type] || '#c9b07a'; }

function _dsSignKey(date) { return `ds_signed_${date}`; }
function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function dsAnnounce(msg) {
    const el = document.getElementById('ds-live-region');
    if (el) { el.textContent = msg; setTimeout(() => { if(el) el.textContent = ''; }, 1000); }
}
function dsInstallId() {
    let id = localStorage.getItem('ds_install_id');
    if (!id) {
        id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem('ds_install_id', id);
    }
    return id;
}

function dsIsDebugMap() {
    const debug = localStorage.getItem('ds_debug_map') === 'true';
    if (!debug) return false;
    // Auto-clear debug if more than 1 day old
    const debugDate = localStorage.getItem('ds_debug_map_date');
    if (debugDate) {
        const d1 = new Date(debugDate);
        const d2 = new Date();
        const days = Math.abs(d2 - d1) / (1000 * 60 * 60 * 24);
        if (days > 1) {
            localStorage.removeItem('ds_debug_map');
            localStorage.removeItem('ds_debug_map_date');
            return false;
        }
    }
    return true;
}

function dsDebugMap(on = true) {
    localStorage.setItem('ds_debug_map', on ? 'true' : 'false');
    if (on && _dsData?.date) localStorage.setItem('ds_debug_map_date', _dsData.date);
    showScreen('plugin-the_daily');  // Use showScreen to ensure HTML is loaded first
}

function dsDebugMapDay(delta) {
    const base = localStorage.getItem('ds_debug_map_date') || _dsData?.date || new Date().toISOString().slice(0, 10);
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    localStorage.setItem('ds_debug_map_date', d.toISOString().slice(0, 10));
    showScreen('plugin-the_daily');  // Use showScreen to ensure HTML is loaded first
}

function dsDebugMapToday() {
    localStorage.setItem('ds_debug_map_date', new Date().toISOString().slice(0, 10));
    showScreen('plugin-the_daily');  // Use showScreen to ensure HTML is loaded first
}


function dsRenderDebugHeader() {
    const header = document.getElementById('ds-debug-header');
    if (!header || !window.slopsmith) return;
    
    const debugDate = localStorage.getItem('ds_debug_map_date');
    const isDebug = localStorage.getItem('ds_debug_map') === 'true';
    
    let debugText = '';
    if (isDebug) {
        debugText = debugDate ? `Debug: ${debugDate}` : 'Debug: ON (no date)';
    }
    
    header.innerHTML = `<span class="ds-debug-label">${debugText}</span>`;
    header.style.display = isDebug ? 'inline' : 'none';
}
function dsApiUrl(path) {
    const sep = path.includes('?') ? '&' : '?';
    const debugDate = localStorage.getItem('ds_debug_map_date');
    const debug = dsIsDebugMap() ? `&debug_map=1${debugDate ? `&debug_date=${encodeURIComponent(debugDate)}` : ''}` : '';
    return `${path}${sep}install_id=${encodeURIComponent(dsInstallId())}${debug}`;
}

// ── Screen hook ──────────────────────────────────────────────────────────────
(function () {
    const orig = window.showScreen;
    window._dsOrigShowScreen = orig;
    window.showScreen = function (id) {
        console.log('[daily] showScreen called with id:', id);
        orig(id);
        if (id === 'plugin-the_daily') {
            console.log('[daily] showing the_daily screen, will init after DOM updates');
            // Wait longer and keep polling for DOM
            let attempts = 0;
            const tryInit = async () => {
                attempts++;
                const parent = document.getElementById('plugin-the_daily');
                // The plugin's screen.html is now just a loading shell (#ds-loading);
                // the 3D dungeon overlay takes over from there. Use #ds-loading as
                // the "HTML is mounted" marker that gates dsInit().
                let marker = document.getElementById('ds-loading');
                if (!marker) marker = parent?.querySelector('#ds-loading');
                // If HTML missing, fetch and inject it.
                if (parent && !marker && attempts <= 3) {
                    try {
                        const resp = await fetch('/api/plugins/the_daily/screen.html');
                        const html = await resp.text();
                        parent.innerHTML = html;
                        marker = document.getElementById('ds-loading') || parent.querySelector('#ds-loading');
                    } catch(e) { console.log('[daily] HTML fetch failed:', e); }
                }
                if (!_dsInitialized && marker) {
                    _dsInitialized = true;
                    dsInit();
                } else if (attempts < 20) {
                    setTimeout(tryInit, 100);
                }
            };
            setTimeout(tryInit, 100);
        }
    };
})();

// Register event listeners once
if (typeof window !== 'undefined' && window.slopsmith) {
    window.slopsmith.on('song:play', (e) => {
        if (_dsPlayingCfId) {
            _dsPlayStartTime = Date.now();
        }
    });
    window.slopsmith.on('song:ended', async (e) => {
        if (_dsPlayingCfId && _dsPlayStartTime > 0) {
            const durationPlayed = Math.floor((Date.now() - _dsPlayStartTime) / 1000);
            await dsMarkSong(_dsPlayingCfId, durationPlayed, _dsPlayingNodeId);
            _dsPlayingCfId = null;
            _dsPlayingNodeId = null;
            _dsPlayStartTime = 0;
        }
        if (_dsBossJustCompleted) {
            _dsReturnAfterPlayback = false;
            _dsInitialized = false;
            showScreen('plugin-the_daily');
        } else if (_dsReturnAfterPlayback) {
            _dsReturnAfterPlayback = false;
            showScreen('plugin-the_daily');
            // Rebuild the 3D dungeon in place rather than leaving the legacy 2D
            // map showing. start() lands the player back in the room they just
            // cleared and plays the unseal beat (_dsRoomJustCleared).
            if (dsDungeonEnabled()) await dsResumeDungeon();
        }
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function dsInit() {
    console.log('[daily] dsInit starting, debug:', dsIsDebugMap());
    dsShow('loading');
    try {
        const apiUrl = dsApiUrl('/api/plugins/the_daily/today');
        console.log('[daily] fetching:', apiUrl);
        const resp = await fetch(apiUrl);
        const text = await resp.text();
        console.log('[daily] response status:', resp.status, 'length:', text.length);
        _dsData = text ? JSON.parse(text) : null;
        if (!_dsData) {
            console.log('[daily] empty response');
            dsShowError('Empty response from server.');
            return;
        }
        if (_dsData.error) {
            console.log('[daily] got error:', _dsData.error);
            if (_dsData.error === 'offline') {
                await dsDungeonEnterError('offline');
                return;
            }
            if (_dsData.error === 'update_required') {
                await dsDungeonEnterError('update_required', _dsData.min_version);
                return;
            }
            dsShowError(_dsData.error);
            return;
        }
        console.log('[daily] data loaded, date:', _dsData.date, 'modifier:', _dsData.modifier?.id);
        // Start in Leaderboard view unless today is marked complete on first load
        _dsInCompleteView = !!_dsData?.is_complete;
        // Initialize leaderboard date controls to today
        const today = new Date(_dsData.date + 'T12:00:00');
        const ymd = today.toISOString().slice(0, 10);
        _dsLbDate = ymd;
        const dateInput = document.getElementById('ds-lb-date');
        if (dateInput) {
            dateInput.value = ymd;
            // Min bound equals Day 1 date; set max to today
            dateInput.min = '2026-04-22';
            dateInput.max = new Date().toISOString().slice(0, 10);
        }
        // The Daily is a 3D dungeon experience; there is no longer a 2D fallback.
        if (_dsBossJustCompleted) {
            // Daily complete: drop the player straight into the Wall of Fame
            // room, where the celebration plays and they sign — no hub detour.
            const streak = _dsPendingBossStreak || 0;
            _dsBossJustCompleted = false;
            await dsEnterWof(_dsData, { celebrate: true, streak });
        } else {
            await dsDungeonEnter(_dsData);
        }
        // Refresh tokens after loading setlist
        dsRefreshTokens();
    } catch (e) {
        dsShowError('Failed to load daily setlist.');
    }
}

function dsLaneLabel(id) {
    const labels = { standard: 'Standard', drop: 'Drop', flat: 'Flat', sprint: 'Sprint', marathon: 'Marathon', daily: 'Daily' };
    if (!id) return '';
    if (/^decade_\d{4}s$/.test(id)) return id.slice('decade_'.length);
    return labels[id] || id.replace(/_/g, ' ');
}

function dsNodeIcon(n) {
    if (!n) return '●';
    return NODE_TYPE_ICONS[n.type] || '●';
}

// ── Rescan Library ────────────────────────────────────────────────────────────
async function dsRescanLibrary(externalBtn) {
    const btn = externalBtn || document.getElementById('ds-btn-rescan');
    const status = document.getElementById('ds-rescan-status');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    btn.classList.add('opacity-50');
    try {
        const resp = await fetch('/api/rescan', { method: 'POST' });
        const data = await resp.json();
        if (status) status.textContent = data.message || 'Scanning...';
    } catch (e) {
        if (status) status.textContent = 'Failed to start scan.';
        btn.disabled = false;
        btn.textContent = 'Rescan Library';
        btn.classList.remove('opacity-50');
        return;
    }
    const poll = setInterval(async () => {
        try {
            const sr = await fetch('/api/scan-status');
            const sd = await sr.json();
            if (sd.running) {
                const cur = sd.current ? ` · ${sd.current}` : '';
                if (status) status.textContent = `${sd.done} / ${sd.total} scanned${cur}...`;
            } else {
                clearInterval(poll);
                btn.disabled = false;
                btn.textContent = 'Rescan Library';
                btn.classList.remove('opacity-50');
                if (status) status.textContent = sd.error ? `Error: ${sd.error}` : 'Done — refreshing setlist...';
                if (typeof window.loadLibrary === 'function') {
                    window._treeStats = null;
                    window.loadLibrary();
                }
                // Refresh in place when the dungeon is active so we don't tear
                // it down mid-encounter (which would dismiss the overlay and
                // make the player feel teleported past the current room).
                try {
                    const r = await fetch(dsApiUrl('/api/plugins/the_daily/today'));
                    const txt = await r.text();
                    const fresh = txt ? JSON.parse(txt) : null;
                    if (fresh && _dsData && !fresh.error) {
                        Object.assign(_dsData, fresh);
                        if (_dsDungeon && typeof _dsDungeon.refresh === 'function') {
                            _dsDungeon.refresh();
                        } else if (_dsHub && typeof _dsHub.refresh === 'function') {
                            _dsHub.refresh();
                        } else {
                            dsInit();
                        }
                    } else {
                        dsInit();
                    }
                } catch (e) {
                    dsInit();
                }
                dsRefreshTokens();
            }
        } catch (e) {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = 'Rescan Library';
            btn.classList.remove('opacity-50');
            if (status) status.textContent = 'Lost contact with scanner.';
        }
    }, 1000);
}

function dsFmtDuration(secs) {
    if (typeof secs === 'string') return secs;
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// Countdown to next daily at midnight
function dsOpenNode(nodeId) {
    if (!_dsData?.map) return;
    const panel = document.getElementById('ds-map-panel');
    const node = _dsData.map.nodes.find(n => n.id === nodeId);
    if (!panel || !node) return;
    const songMap = Object.fromEntries((_dsData.songs || []).map(s => [s.cf_id, s]));
    const cleared = new Set(_dsData.cleared_node_ids || []);
    const available = new Set(_dsData.available_node_ids || []);
    const canPlay = available.has(nodeId) || cleared.has(nodeId);
    let body = '';
    const debugControls = _dsData.debug_no_save ? `<button onclick="dsUseLaneReroll('${nodeId}')" class="w-full mt-2 px-3 py-1.5 rounded-lg border border-yellow-700/40 bg-yellow-900/20 text-xs text-yellow-300 hover:bg-yellow-900/40 transition">🎲 Lane Re-roll (Debug)</button>` : '';
    if (node.type === 'choice') {
        body = (node.cf_ids || []).map((id, i) => dsMapSongOption(node, songMap[id], `Option ${i + 1}`, canPlay)).join('');
    } else if (node.type === 'mystery') {
        const pool = node.cf_pool || [];
        const idx = dsStableIndex(`${dsInstallId()}:${_dsData.date}:${node.id}`, pool.length);
        const song = songMap[pool[idx]];
        body = dsMapSongOption(node, song, 'Mystery revealed', canPlay);
    } else if (node.type === 'shop') {
        return dsOpenShopNode(nodeId);
    } else if (node.type === 'rest') {
        return dsOpenRest(nodeId);
    } else if (node.type === 'treasure') {
        return dsOpenTreasure(nodeId);
    } else if (node.type === 'event') {
        panel.innerHTML = `<div class="bg-dark-700/50 border border-accent/30 rounded-2xl p-4 text-center">
            <h3 class="text-white font-semibold mb-2">Special Event</h3>
            <p class="text-sm text-gray-400 mb-4">You've encountered a special event node. Events are coming soon!</p>
            <button onclick="dsClearNode('${nodeId}')" class="bg-accent px-4 py-2 rounded-xl text-xs font-semibold text-white">Continue</button>
        </div>`;
    } else {
        body = dsMapSongOption(node, songMap[node.cf_id], node.type === 'boss' && !_dsData.boss_revealed ? 'Boss' : 'Song', canPlay);
    }
    panel.innerHTML = `<div class="bg-dark-700/50 border border-accent/30 rounded-2xl p-4 text-left">
        <div class="flex items-center gap-2 mb-3"><span class="text-xl">${dsNodeIcon(node)}</span><span class="text-sm font-semibold text-white">${esc(node.id)} · ${esc(dsLaneLabel(node.lane) || node.type)}</span></div>
        <div class="space-y-3">${body}</div>
        ${debugControls}
    </div>`;
    dsAnnounce(`${esc(node.id)} node selected`);
}

function dsMapSongOption(node, song, label, canPlay) {
    if (!song) return '<div class="text-sm text-red-400">Song missing from payload.</div>';
    const title = node.type === 'boss' && !_dsData.boss_revealed ? '???' : esc(song.title);
    const local = song.has_locally && song.local_filename;
    const action = local && canPlay
        ? `<button onclick='dsPlayMapNode("${esc(node.id)}",${song.cf_id},"${esc(song.local_filename)}")' class="bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-xs font-semibold text-white transition">Play</button>`
        : !local
            ? `<div class="flex items-center gap-2">
                <button onclick='dsAcquire(${song.cf_id},"${esc(node.id)}","${esc(song.cf_url || '')}",this)' class="px-4 py-2 bg-accent hover:bg-accent-light rounded-xl text-xs font-semibold text-white transition whitespace-nowrap">Get song</button>
                <button onclick="dsRescanLibrary(this)" class="px-3 py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-xl text-xs text-gray-400 transition" title="Rescan library for this song">⟳</button>
               </div>`
            : `<span class="text-xs text-gray-500">Locked</span>`;
    return `<div class="flex items-center gap-3 bg-dark-800/60 border border-gray-800 rounded-xl p-3">
        <div class="flex-1 min-w-0"><div class="text-xs text-accent-light uppercase tracking-wider mb-1">${esc(label)}</div>
        <div class="text-sm font-medium text-white">${title}</div><div class="text-xs text-gray-500">${esc(song.artist || '')} · ${esc(song.tuning || '—')} ${song.duration ? '· ' + esc(dsFmtDuration(song.duration)) : ''}</div></div>${action}</div>`;
}

function dsStableIndex(text, length) {
    if (!length) return 0;
    let h = 0;
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    return Math.abs(h) % length;
}

async function dsPlayMapNode(nodeId, cfId, filename) {
    try {
        await fetch('/api/plugins/the_daily/mark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(),
                node_id: nodeId,
                cf_id: cfId,
                duration_played: 0,
                action: 'commit',
                debug_no_save: !!_dsData.debug_no_save,
                cleared_node_ids: _dsData.cleared_node_ids || [],
                committed_node_ids: _dsData.committed_node_ids || [],
            }),
        });
    } catch (e) {}
    if (_dsDungeon) dsDungeonExit();
    dsPlay(cfId, filename, nodeId);
}

async function dsPlay(cfId, filename) {
    const nodeId = arguments.length > 2 ? arguments[2] : null;
    _dsReturnAfterPlayback = true;
    _dsPlayStartTime = Date.now();  // Track when song started
    _dsPlayingCfId = cfId;         // Track which song is playing
    _dsPlayingNodeId = nodeId;
    playSong(encodeURIComponent(filename));
}

// Refresh the day's data in place without tearing down the dungeon/hub
// (reuses the post-rescan pattern). Used after an Acquisition lands.
async function dsRefreshInPlace() {
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/today'));
        const txt = await r.text();
        const fresh = txt ? JSON.parse(txt) : null;
        if (fresh && _dsData && !fresh.error) {
            Object.assign(_dsData, fresh);
            if (_dsDungeon && typeof _dsDungeon.refresh === 'function') _dsDungeon.refresh();
            else if (_dsHub && typeof _dsHub.refresh === 'function') _dsHub.refresh();
            else dsInit();
        } else {
            dsInit();
        }
    } catch (e) { dsInit(); }
}

// Acquire a song for a Room (ADR 0011). /acquire resolves the Unlock cache;
// on a miss/needs-webview it hands off to the desktop webview Capture (the
// human clicks download in-app, we capture the Host URL + file), then /capture
// finalizes + Unlocks it for everyone. Falls back to opening CustomsForge in
// the browser when the desktop bridge isn't present (Docker).
async function dsAcquire(cfId, nodeId, cfUrl, btn) {
    const setBusy = (t) => { if (btn) { if (!btn.dataset.label) btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = t; } };
    const clearBusy = () => { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Get song'; } };
    setBusy('Getting…');
    try {
        const resp = await fetch('/api/plugins/the_daily/acquire', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ install_id: dsInstallId(), cf_id: cfId, node_id: nodeId || null }),
        });
        const txt = await resp.text();
        const r = txt ? JSON.parse(txt) : {};

        if (r.status === 'acquired' || r.status === 'have') { dsAnnounce('Song ready'); await dsRefreshInPlace(); return; }
        if (r.status === 'reported') { dsAnnounce('Song unavailable — room cleared'); await dsRefreshInPlace(); return; }

        // manual / miss / needs_webview — a human Capture is required.
        const desktop = window.slopsmithDesktop && window.slopsmithDesktop.capture;
        const url = cfUrl || r.cf_url;
        if (desktop && typeof desktop.songDownload === 'function') {
            setBusy('Download in CF window…');
            let cap;
            try { cap = await desktop.songDownload(url, r.dlc_dir); }
            catch (e) { cap = { ok: false, error: String(e) }; }
            if (cap && cap.ok) {
                setBusy('Installing…');
                const cr = await fetch('/api/plugins/the_daily/capture', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ install_id: dsInstallId(), cf_id: cfId, node_id: nodeId || null, host_url: cap.hostUrl, save_path: cap.savePath }),
                });
                const ctxt = await cr.text();
                const cres = ctxt ? JSON.parse(ctxt) : {};
                if (cres.status === 'reported') dsAnnounce('Song unavailable — room cleared');
                else if (cres.status === 'acquired') dsAnnounce('Song ready');
                else dsAnnounce('Could not install song');
                await dsRefreshInPlace();
                return;
            }
            // Capture produced no file (the host page didn't auto-download, or
            // the user cancelled). If the webview reached a known file host, let
            // the server resolve that page — MediaFire/Drive/Dropbox pages that
            // need a click in a browser still resolve headlessly server-side
            // (e.g. MediaFire's legacy /download/<key> page that never fires the
            // download event the webview waits on).
            if (cap && cap.hostUrl) {
                if (await dsCaptureHostUrl(cfId, nodeId, cap.hostUrl, btn)) return;
                await dsPromptCaptureLink(cfId, nodeId, btn);  // reached a host but the fetch failed
                clearBusy();
                return;
            }
            // No host reached. Don't nag on a deliberate cancel; offer the paste
            // path only when the capture actually errored.
            if (cap && !cap.cancelled) await dsPromptCaptureLink(cfId, nodeId, btn);
            clearBusy();
            return;
        }
        // Browser/Docker: no capture bridge — open the source page, then let the
        // user paste the direct host link they reach so the server can fetch it.
        if (url) window.open(url, '_blank', 'noopener');
        await dsPromptCaptureLink(cfId, nodeId, btn);
        clearBusy();
    } catch (e) {
        dsAnnounce('Acquire failed');
        clearBusy();
    }
}

// Hand a direct file-host link to the server, which fetches + validates it and
// Unlocks the song for everyone (ADR 0011 /capture). Returns true if the song
// landed (acquired) or was conclusively rejected (reported); false if the caller
// should keep offering options. The server resolver handles Dropbox / Google
// Drive / MediaFire (incl. the /download/<key>, /folder/, and app. variants).
async function dsCaptureHostUrl(cfId, nodeId, host_url, btn) {
    if (!host_url) return false;
    const prev = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }
    try {
        const cr = await fetch('/api/plugins/the_daily/capture', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ install_id: dsInstallId(), cf_id: cfId, node_id: nodeId || null, host_url }),
        });
        const ctxt = await cr.text();
        const cres = ctxt ? JSON.parse(ctxt) : {};
        if (cres.status === 'acquired') { dsAnnounce('Song ready'); await dsRefreshInPlace(); return true; }
        if (cres.status === 'reported') { dsAnnounce('That link isn\'t a playable CDLC'); await dsRefreshInPlace(); return true; }
        dsAnnounce(cres.error ? ('Could not fetch: ' + cres.error) : 'Could not fetch that link');
        if (btn && prev) btn.textContent = prev;
        return false;
    } catch (e) {
        dsAnnounce('Capture failed');
        if (btn && prev) btn.textContent = prev;
        return false;
    }
}

// Ask the user to paste a direct host link, then capture it. window.prompt is
// blocked in the Electron desktop app, so this uses a small DOM modal that works
// over both the canvas dungeon and the DOM encounter panels.
async function dsPromptCaptureLink(cfId, nodeId, btn) {
    const host_url = await dsAskHostLink();
    if (!host_url) return false;
    return dsCaptureHostUrl(cfId, nodeId, host_url, btn);
}

function dsAskHostLink() {
    return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.72);display:flex;align-items:center;justify-content:center;font-family:monospace;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#0b0b0d;border:1px solid #333;border-radius:12px;padding:20px;max-width:460px;width:90%;color:#cfd3da;';
        box.innerHTML =
            '<div style="font-size:0.95rem;color:#e8c040;margin-bottom:8px;">Paste the download link</div>' +
            '<div style="font-size:0.8rem;color:#8a8f98;margin-bottom:12px;line-height:1.4;">' +
            'The page opened but didn’t download automatically. Copy the file link ' +
            '(MediaFire / Dropbox / Google Drive / etc.) and paste it here — we’ll ' +
            'fetch and install it, and unlock it for everyone.</div>' +
            '<input id="ds-host-input" type="text" placeholder="https://www.mediafire.com/…" autocomplete="off" ' +
            'style="width:100%;box-sizing:border-box;background:#16161a;border:1px solid #333;border-radius:8px;color:#fff;padding:10px;font-family:monospace;font-size:0.85rem;margin-bottom:14px;">' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="ds-host-cancel" style="background:#1a1a1e;border:1px solid #333;border-radius:8px;color:#aaa;padding:8px 14px;cursor:pointer;">Cancel</button>' +
            '<button id="ds-host-ok" style="background:#2f6fc2;border:none;border-radius:8px;color:#fff;padding:8px 14px;cursor:pointer;font-weight:bold;">Fetch</button>' +
            '</div>';
        ov.appendChild(box);
        document.body.appendChild(ov);
        const input = box.querySelector('#ds-host-input');
        const done = (val) => { ov.remove(); resolve(val); };
        box.querySelector('#ds-host-cancel').onclick = () => done(null);
        box.querySelector('#ds-host-ok').onclick = () => done((input.value || '').trim() || null);
        ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
        // Stop dungeon WASD/window key handlers from eating the typing.
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') done((input.value || '').trim() || null);
            else if (e.key === 'Escape') done(null);
        });
        setTimeout(() => input.focus(), 30);
    });
}

// Mark song completion (called when song:ended fires)
async function dsMarkSong(cfId, durationPlayed = 0, nodeId = null) {
    try {
        const resp = await fetch('/api/plugins/the_daily/mark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(),
                cf_id: cfId,
                node_id: nodeId,
                duration_played: durationPlayed,
                debug_no_save: !!_dsData?.debug_no_save,
                cleared_node_ids: _dsData?.cleared_node_ids || [],
                committed_node_ids: _dsData?.committed_node_ids || [],
            }),
        });

        if (resp.ok) {
            const text = await resp.text();
            if (text) {
                const result = JSON.parse(text);

                // If not enough play time, prompt user
                if (result.requires_confirmation) {
                    console.log(`Played ${durationPlayed}s, need ${result.threshold}s to complete`);
                    return;
                }

                // Update local state
                    if (_dsData && result.ok) {
                        _dsData.progress = result.progress;
                        const song = _dsData.songs.find(s => s.cf_id === cfId);
                        if (song) song.done = true;
                        ['cleared_node_ids', 'available_node_ids', 'locked_node_ids', 'committed_node_ids'].forEach(k => {
                            if (result[k]) _dsData[k] = result[k];
                        });
                        if (typeof result.boss_revealed !== 'undefined') _dsData.boss_revealed = result.boss_revealed;
                        if (result.inventory) _dsData.inventory = result.inventory;
                        _dsData.is_complete = result.is_complete;
                        // Replay the door-unseal beat when the rebuilt dungeon lands the
                        // player back in the room they just song-cleared (boss has its own
                        // celebration, so it's excluded).
                        if (nodeId && !result.is_complete && (result.cleared_node_ids || []).includes(nodeId)) {
                            _dsRoomJustCleared = nodeId;
                        }
                        // The 3D scene is rebuilt on return (see song:ended →
                        // dsResumeDungeon), which lands the player back in the
                        // cleared room.
                        dsRefreshTokens(); // Refresh token count after song completion

                    if (result.is_complete && _dsData.map) {
                        _dsBossJustCompleted = true;
                        try {
                            const sResp = await fetch('/api/plugins/the_daily/streak');
                            const sText = await sResp.text();
                            const sData = sText ? JSON.parse(sText) : {};
                            _dsPendingBossStreak = sData.streak || 0;
                        } catch (e) { _dsPendingBossStreak = 0; }
                        dsAnnounce('Daily complete! Well done!');
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to mark song:', e);
    }
}

// The only DOM view that survives outside the 3D overlay is the loading
// spinner; everything else is a diegetic dungeon room.
function dsShow(view) {
    const el = document.getElementById('ds-loading');
    if (el) el.classList.toggle('hidden', view !== 'loading');
}

// Fatal errors surface in the dungeon overlay (the 2D fallback screens are gone).
function dsShowError(msg) {
    let overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ds-dungeon-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;';
    overlay.style.display = 'flex';
    _dsShowDungeonFatal(overlay, 'Something went wrong', esc(msg));
}

// ── Confetti ──────────────────────────────────────────────────────────────────
let _dsShopFilter = 'all';
let _dsCurrentNodeId = null; // track node_id when opened from map

async function dsRefreshTokens() {
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/inventory'),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        const el = document.querySelector('#ds-token-counter .value');
        const old = parseInt(el?.textContent, 10) || 0;
        const next = data.tokens || 0;
        if (el) el.textContent = next;
        if (next > old) dsAnimateTokenDelta(next - old);
        dsApplyEquipped(data.equipped || {});
    } catch (e) {
        console.error('Failed to refresh tokens:', e);
    }
}

function dsAnimateTokenDelta(delta) {
    const chip = document.getElementById('ds-token-counter');
    if (!chip) return;
    const float = document.createElement('div');
    float.className = 'absolute -top-4 right-0 text-yellow-400 text-xs animate-bounce';
    float.textContent = `+${delta}`;
    chip.style.position = 'relative';
    chip.appendChild(float);
    setTimeout(() => float.remove(), 1500);
}

function dsRenderShopItem(item, forNode = false) {
    const cost = item.discounted_cost ?? item.cost;
    const discount = item.discounted_cost ? `<span class="line-through text-gray-500 mr-1">${item.cost}</span>` : '';
    const buttonState = item.owned ? (item.equipped ? 'Equipped' : 'Owned') : (item.affordable ? 'Buy' : 'Not enough');
    const disabled = item.owned || !item.affordable;
    const canRefund = item.is_cosmetic && item.owned && dsCanRefund(item);
    const refundLink = canRefund ? `<button onclick="dsRefundItem('${esc(item.id)}')" class="ml-2 text-xs text-red-400 hover:underline">Refund</button>` : '';
    const isEquipped = item.equipped === true;
    const equipBtn = item.owned && item.is_cosmetic && !item.is_consumable
        ? `<button onclick="dsEquipToggle('${item.slot}', '${esc(item.id)}', ${isEquipped})" class="ml-2 px-2 py-0.5 rounded text-xs ${isEquipped ? 'bg-green-700 text-green-200' : 'bg-dark-600 text-gray-400'}">${isEquipped ? 'Equipped' : 'Equip'}</button>`
        : '';
    return `<div class="bg-dark-700 border border-gray-700 rounded-2xl p-3 flex flex-col">
        <div class="text-sm font-semibold text-white">${esc(item.name)}</div>
        <div class="text-xs text-gray-500 mb-2">${esc(item.description || item.type)}</div>
        <div class="mt-auto flex items-center justify-between">
            <span class="text-yellow-400 text-sm">🪙 ${discount}${cost}</span>
            <div class="flex items-center">
                ${equipBtn}
                <button onclick="dsBuyItem('${esc(item.id)}', ${forNode ? `'${esc(_dsCurrentNodeId || '')}'` : 'null'})" ${disabled ? 'disabled' : ''}
                        aria-label="Buy ${esc(item.name)} for ${cost} tokens"
                        class="px-3 py-1 rounded-xl bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs whitespace-nowrap">
                    ${buttonState}
                </button>
                ${refundLink}
            </div>
        </div>
    </div>`;
}

async function dsLoadShop(nodeId = null) {
    // The full-screen 2D shop is gone; in a dungeon shop encounter the offer
    // lives in #ds-map-panel, so repaint that via dsOpenShopNode instead.
    if (!document.getElementById('ds-shop-items')) {
        if (nodeId && document.getElementById('ds-map-panel')) dsOpenShopNode(nodeId);
        return;
    }
    try {
        const url = nodeId
            ? `/api/plugins/the_daily/shop?node_id=${encodeURIComponent(nodeId)}`
            : '/api/plugins/the_daily/shop';
        const r = await fetch(dsApiUrl(url), { headers: { 'X-Install-Id': dsInstallId() } });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        if (data.error) {
            document.getElementById('ds-shop-items').innerHTML = `<p class="text-red-400 text-sm">${esc(data.error)}</p>`;
            return;
        }
        document.getElementById('ds-shop-tokens').textContent = data.tokens;
        const filter = _dsShopFilter;
        const filtered = data.items.filter(i =>
            filter === 'all' ||
            (filter === 'cosmetic' && i.is_cosmetic) ||
            (filter === 'consumable' && !i.is_cosmetic)
        );
        document.getElementById('ds-shop-items').innerHTML = filtered.map(i => dsRenderShopItem(i, !!nodeId)).join('');
    } catch (e) {
        document.getElementById('ds-shop-items').innerHTML = `<p class="text-red-400 text-sm">Failed to load shop.</p>`;
    }
}

async function dsBuyItem(itemId, nodeId = null) {
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/shop/buy'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ item_id: itemId, node_id: nodeId }),
        });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        if (data.error) { alert(data.error); return; }
        dsRefreshTokens();
        dsLoadShop(nodeId);
        if (data.effect?.rerolled) {
            dsLoadToday();
        }
    } catch (e) {
        alert('Failed to purchase item.');
    }
}

function dsCanRefund(item) {
    if (!item.purchased_at) return false;
    return (Date.now() / 1000) - item.purchased_at < 60;
}

async function dsRefundItem(itemId) {
    if (!confirm('Refund this item? Tokens will be returned.')) return;
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/refund'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ item_id: itemId }),
        });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        if (data.error) { alert(data.error); return; }
        dsRefreshTokens();
        dsLoadShop(_dsCurrentNodeId);
    } catch (e) {
        alert('Failed to refund item.');
    }
}

async function dsEquip(slot, cosmeticId) {
    try {
        await fetch(dsApiUrl('/api/plugins/the_daily/equip'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ slot, cosmetic_id: cosmeticId }),
        });
        dsRefreshTokens();
    } catch (e) {
        console.error('Failed to equip:', e);
    }
}

async function dsEquipToggle(slot, cosmeticId, currentlyEquipped) {
    const newId = currentlyEquipped ? null : cosmeticId;
    await dsEquip(slot, newId);
    dsLoadShop(_dsCurrentNodeId);
}

function dsApplyEquipped(equipped) {
    const root = document.querySelector('.daily-root');
    if (!root) return;
    // Remove all theme-*, skin-*, flair-*, calendar-art-* classes
    [...root.classList].forEach(c => {
        if (/^(theme|skin|flair|calendar-art)-/.test(c)) root.classList.remove(c);
    });
    // Map cosmetic ids to CSS classes
    // flair_glow -> flair-glow, theme_papercraft -> theme-papercraft
    // skin_neonsprint -> skin-neonsprint, calendar_pastel -> calendar-art-pastel
    const mapping = {
        flair: 'flair',
        map_theme: 'theme',
        lane_skin: 'skin',
        calendar_art: 'calendar-art',
    };
    Object.entries(equipped).forEach(([slot, id]) => {
        if (!id) return;
        const prefix = mapping[slot];
        if (!prefix) return;
        const className = `${prefix}-${id.replace(/_/g, '-').replace(/^([a-z]+)-/, '')}`;
        root.classList.add(className);
    });
}

async function dsClearNode(nodeId) {
    try {
        const resp = await fetch(dsApiUrl(`/api/plugins/the_daily/nodes/${encodeURIComponent(nodeId)}/clear`), {
            method: 'POST',
            headers: { 'X-Install-Id': dsInstallId() }
        });
        const text = await resp.text();
        const result = text ? JSON.parse(text) : null;
        // Fast path: if we're in the live dungeon and just cleared the room we're
        // standing in, merge the fresh state and animate the exits unsealing in
        // place — no teardown/rebuild. clearCurrentRoom returns false if the node
        // isn't the current room, in which case we fall back to a full refresh.
        if (result && result.cleared_node_ids) {
            if (_dsData) {
                ['cleared_node_ids', 'available_node_ids', 'locked_node_ids', 'committed_node_ids'].forEach(k => {
                    if (result[k]) _dsData[k] = result[k];
                });
                if (typeof result.boss_revealed !== 'undefined') _dsData.boss_revealed = result.boss_revealed;
                if (result.inventory) _dsData.inventory = result.inventory;
                if (typeof result.is_complete !== 'undefined') _dsData.is_complete = result.is_complete;
                if (result.progress) _dsData.progress = result.progress;
            }
            if (_dsDungeon && typeof _dsDungeon.clearCurrentRoom === 'function'
                && _dsDungeon.clearCurrentRoom(nodeId, result)) {
                return;
            }
        }
        await dsInit();
    } catch (e) {
        console.error('Failed to clear node:', e);
        try { await dsInit(); } catch (_) {}
    }
}

async function dsBankProgress(nodeId) {
    try {
        await fetch(dsApiUrl(`/api/plugins/the_daily/rest/${encodeURIComponent(nodeId)}`), {
            method: 'POST',
            headers: { 'X-Install-Id': dsInstallId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bank' })
        });
        await dsClearNode(nodeId);
    } catch (e) {
        console.error('Failed to bank progress:', e);
    }
}

async function dsOpenRest(nodeId) {
    const panel = document.getElementById('ds-map-panel');
    if (!panel) return;
    try {
        const r = await fetch(dsApiUrl(`/api/plugins/the_daily/rest/${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const song = await r.json();
        panel.innerHTML = `
            <div class="bg-dark-700/50 border border-green-700/40 rounded-2xl p-4">
                <div class="flex items-center gap-2 mb-3">
                    <span class="text-xl">🛌</span>
                    <span class="text-sm font-semibold text-white">Rest Node</span>
                </div>
                <div class="space-y-4">
                    <div class="bg-dark-800/80 rounded-xl p-3 border border-white/5">
                        <div class="text-xs text-white/50 mb-1 uppercase tracking-wider font-bold">Liner Notes</div>
                        <div class="text-sm text-white/90 leading-relaxed">${esc(song.notes || 'No notes available.')}</div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <button onclick="dsBankProgress('${nodeId}')" class="w-full px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-xl font-bold transition shadow-lg shadow-green-900/20">💰 Bank Progress</button>
                        <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Leave</button>
                    </div>
                </div>
            </div>`;
    } catch (e) {
        panel.innerHTML = '<div class="text-sm text-red-400">Failed to load rest node.</div>';
    }
}

async function dsChooseTreasure(nodeId, type) {
    try {
        await fetch(dsApiUrl(`/api/plugins/the_daily/treasure/${encodeURIComponent(nodeId)}`), {
            method: 'POST',
            headers: { 'X-Install-Id': dsInstallId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ peek_type: type })
        });
        await dsOpenTreasure(nodeId); // Refresh to show result
    } catch (e) {
        console.error('Failed to choose treasure:', e);
    }
}

async function dsOpenTreasure(nodeId) {
    const panel = document.getElementById('ds-map-panel');
    if (!panel) return;
    try {
        const r = await fetch(dsApiUrl(`/api/plugins/the_daily/treasure/${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const data = await r.json();
        
        if (data.chosen) {
            // Already chosen, show result
            panel.innerHTML = `
                <div class="bg-dark-700/50 border border-yellow-700/40 rounded-2xl p-4">
                    <div class="flex items-center gap-2 mb-3">
                        <span class="text-xl">💎</span>
                        <span class="text-sm font-semibold text-white">Treasure: ${esc(data.chosen)}</span>
                    </div>
                    <div class="bg-dark-800/80 rounded-xl p-3 border border-white/5 mb-4 text-xs text-yellow-200/80 whitespace-pre-wrap">
                        ${esc(JSON.stringify(data.payload, null, 2))}
                    </div>
                    <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Leave</button>
                </div>`;
            return;
        }

        const optionsHtml = data.options.map(opt => `
            <button onclick="dsChooseTreasure('${nodeId}', '${opt.type}')" 
                class="w-full px-4 py-3 bg-dark-800/80 hover:bg-dark-700 border border-white/5 hover:border-yellow-700/40 rounded-xl text-left transition group">
                <div class="text-sm font-bold text-white/90 group-hover:text-yellow-400 transition">${esc(opt.label)}</div>
                <div class="text-xs text-white/40">Glimpse into the future...</div>
            </button>
        `).join('');

        panel.innerHTML = `
            <div class="bg-dark-700/50 border border-yellow-700/40 rounded-2xl p-4">
                <div class="flex items-center gap-2 mb-3">
                    <span class="text-xl">💎</span>
                    <span class="text-sm font-semibold text-white">Choose Treasure</span>
                </div>
                <div class="space-y-2 mb-4">
                    ${optionsHtml}
                </div>
                <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Skip & Leave</button>
            </div>`;
    } catch (e) {
        panel.innerHTML = '<div class="text-sm text-red-400">Failed to load treasure.</div>';
    }
}

async function dsOpenShopNode(nodeId) {
    const panel = document.getElementById('ds-map-panel');
    if (!panel) return;
    try {
        const r = await fetch(dsApiUrl(`/api/plugins/the_daily/shop?node_id=${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } });
        const text = await r.text();
        const data = text ? JSON.parse(text) : {};
        const offerSet = new Set(data.discount?.items || []);
        const offerItems = data.items.filter(i => offerSet.has(i.id));
        panel.innerHTML = `<div class="bg-dark-700/50 border border-yellow-700/40 rounded-2xl p-4">
            <div class="flex items-center gap-2 mb-3">
                <span class="text-xl">🛒</span>
                <span class="text-sm font-semibold text-white">Shop · 10% off (today)</span>
            </div>
            <div class="grid grid-cols-1 gap-2 mb-4">
                ${offerItems.map(i => dsRenderShopItem({ ...i, _node_id: nodeId }, true)).join('')}
            </div>
            <button onclick="dsClearNode('${nodeId}')" class="w-full px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white/70 rounded-xl font-semibold transition">🏃 Leave</button>
        </div>`;
    } catch (e) {
        panel.innerHTML = '<div class="text-sm text-red-400">Failed to load shop offer.</div>';
    }
}

// Helper to reload today's setlist after re-roll
async function dsLoadToday() {
    if (_dsData?.map) {
        await dsInit();
    }
}

async function dsUseLaneReroll(nodeId) {
    if (!_dsData?.map) return;
    console.log("DEBUG: Triggering lane re-roll for node:", nodeId);
    console.log("DEBUG: Current inventory:", _dsData.inventory);
    try {
        const resp = await fetch('/api/plugins/the_daily/use-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(),
                item_id: 'lane_reroll',
                node_id: nodeId,
                debug_no_save: !!_dsData.debug_no_save,
            }),
        });
        const text = await resp.text();
        console.log("DEBUG: Reroll response status:", resp.status);
        console.log("DEBUG: Reroll response text:", text);
        const data = text ? JSON.parse(text) : {};
        if (!resp.ok || data.error) {
            const panel = document.getElementById('ds-map-panel');
            if (panel) panel.innerHTML = `<div class="text-sm text-yellow-400 text-center py-3">${esc(data.error || 'Could not use item.')}</div>`;
            return;
        }
        _dsData.inventory = data.inventory;
        if (data.effect?.rerolled) {
            dsLoadToday();
        } else if (_dsData.debug_no_save) {
            dsInit();
        } else {
            await dsInit();
        }
    } catch (e) {
        console.error("DEBUG: Reroll network error:", e);
        const panel = document.getElementById('ds-map-panel');
        if (panel) panel.innerHTML = '<div class="text-sm text-red-400 text-center py-3">Network error using item.</div>';
    }
}

// ── Expose shop globals ──────────────────────────────────────────────────
window.dsRefreshTokens = dsRefreshTokens;
window.dsAnimateTokenDelta = dsAnimateTokenDelta;
window.dsLoadShop = dsLoadShop;
window.dsBuyItem = dsBuyItem;
window.dsRefundItem = dsRefundItem;
window.dsEquip = dsEquip;
window.dsEquipToggle = dsEquipToggle;
window.dsApplyEquipped = dsApplyEquipped;
window.dsOpenShopNode = dsOpenShopNode;
window.dsOpenRest = dsOpenRest;
window.dsOpenTreasure = dsOpenTreasure;
window.dsClearNode = dsClearNode;
window.dsBankProgress = dsBankProgress;
window.dsChooseTreasure = dsChooseTreasure;
window.dsRenderShopItem = dsRenderShopItem;
window.dsUseLaneReroll = dsUseLaneReroll;
window._dsShopFilter = _dsShopFilter;

// ── Dungeon (ThreeJS first-person crawler) ────────────────────────────────────
// Enable with: localStorage.setItem('the_daily_dungeon', '1')

function dsDungeonEnabled() {
    return true;
}

var _dsTHREE = null;
var _dsDungeon = null;
var _dsHub = null;
var _dsErrorScene = null;
var _dsActiveMenuKey = null;

// ── Shared procedural stone texture ─────────────────────────────────────────
// One parametric canvas-texture generator, formerly copy-pasted into every
// scene builder (7× the plain mono variant) plus 6 themed near-clones inside
// the dungeon. `_dsStoneTexture` is the primitive; `_dsStoneBasic` reproduces
// the mono-tinted brick wall used by every builder. Themed dungeon variants
// (elite/boss/treasure/rest/mystery/shop) call the primitive with their own
// brick-colour + accent passes.
//
// opts: { bg:        CSS colour for the background fill,
//         brick:     () => CSS colour, called once per brick,
//         accents:   optional (ctx, sz) => void, drawn after bricks,
//         noise:     per-pixel jitter half-amplitude (default 4; 0 disables),
//         ru, rv:    texture repeat }
function _dsStoneTexture(THREE, opts) {
    const sz = 64;
    const tc = document.createElement('canvas');
    tc.width = tc.height = sz;
    const ctx = tc.getContext('2d');
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, sz, sz);
    const bw = 16, bh = 8;
    for (let y = 0; y < sz; y += bh) {
        const shift = (Math.floor(y / bh) % 2) * (bw / 2);
        for (let xb = 0; xb <= sz + bw; xb += bw) {
            const x = (xb + shift) % sz;
            ctx.fillStyle = opts.brick();
            ctx.fillRect(x, y, bw - 2, bh - 2);
        }
    }
    if (opts.accents) opts.accents(ctx, sz);
    const amp = opts.noise == null ? 4 : opts.noise;
    if (amp > 0) {
        const id = ctx.getImageData(0, 0, sz, sz);
        for (let i = 0; i < id.data.length; i += 4) {
            const n = Math.floor(Math.random() * (amp * 2) - amp);
            id.data[i]   = Math.min(255, Math.max(0, id.data[i]   + n));
            id.data[i+1] = Math.min(255, Math.max(0, id.data[i+1] + n));
            id.data[i+2] = Math.min(255, Math.max(0, id.data[i+2] + n));
        }
        ctx.putImageData(id, 0, 0);
    }
    const t = new THREE.CanvasTexture(tc);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.ru, opts.rv);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    return t;
}

function _dsStoneBasic(THREE, r, g, b, ru, rv, noise) {
    return _dsStoneTexture(THREE, {
        bg: `rgb(${r},${g},${b})`,
        brick: () => {
            const v = r + Math.floor(Math.random() * 18 - 9);
            return `rgb(${Math.max(0,v)},${Math.max(0,v-3)},${Math.max(0,v-5)})`;
        },
        noise: noise,
        ru: ru, rv: rv,
    });
}

// ── Real dungeon textures (COMTEX pack, served from static/textures) ─────────
// Materials are built synchronously with a procedural CanvasTexture so the
// scene renders instantly; the real PNG is loaded async and swapped onto the
// material's .map once decoded. On any failure the procedural fallback stays.
let _dsTexLoader = null;
let _dsMaxAniso = 0;             // hardware max anisotropy, set when a renderer is created
const _dsTexCache = new Map();   // url -> THREE.Texture (shared, never disposed)
function _dsApplyRealTex(THREE, mat, name, ru, rv, tint) {
    try {
        if (!_dsTexLoader) _dsTexLoader = new THREE.TextureLoader();
        const url = '/api/plugins/the_daily/tex/' + name;
        const finish = (tex) => {
            // Per-material clone so each surface owns its own repeat values.
            const t = tex.clone();
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.repeat.set(ru, rv);
            // Trilinear mipmaps + anisotropy kill the shimmer/blur on surfaces
            // receding into the distance (esp. the granite floor at grazing
            // angles); NearestFilter magnification keeps the up-close pixelated
            // Quake look intact. generateMipmaps stays on (POT sources).
            t.minFilter = THREE.LinearMipmapLinearFilter;
            t.magFilter = THREE.NearestFilter;
            t.generateMipmaps = true;
            t.anisotropy = _dsMaxAniso || 8;
            if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
            t.needsUpdate = true;
            const old = mat.map;
            mat.map = t;
            if (tint != null) mat.color.setHex(tint);   // tint multiplies the map
            mat.needsUpdate = true;
            if (old && old.dispose) old.dispose();       // free the procedural canvas tex
        };
        const cached = _dsTexCache.get(url);
        if (cached) { finish(cached); return; }
        _dsTexLoader.load(url, (tex) => {
            _dsTexCache.set(url, tex);
            finish(tex);
        }, undefined, () => { /* keep procedural fallback on error */ });
    } catch (_) { /* THREE missing / no loader — keep fallback */ }
}

// Guarantee every solid surface in a built room carries a real texture.
// Walks the scene graph; any opaque Lambert/Standard/Phong material that
// doesn't already have a .map gets one, chosen by its tint (warm→wood,
// near-black/cool→metal, else stone) and tiled by the mesh's world size so
// texel density stays roughly constant. The material's original color is
// preserved as a multiply tint, so hand-tuned shading survives. Purely
// emissive / additive / transparent FX (flames, glows, banners, glass,
// daises, swirls) are skipped — texturing them would wreck the effect.
function _dsTextureAllSurfaces(THREE, root, disposables) {
    if (!THREE || !root || !root.traverse) return;
    const TEX_WORLD = 1.6;   // ~one tile per 1.6 world units
    root.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry || !obj.material) return;
        if (Array.isArray(obj.material)) return;
        const mat = obj.material;
        if (!mat.color || mat.map) return;                       // no tint slot, or already textured
        if ((mat.userData && mat.userData.noAutoTex) ||
            (obj.userData && obj.userData.noAutoTex)) return;     // explicitly animated by reference
        if (mat.transparent || mat.depthWrite === false) return; // glass / overlays / FX
        if (mat.blending && mat.blending !== THREE.NormalBlending) return; // additive glows
        if (mat.fog === false) return;                           // flame cores / light tips
        const c = mat.color;
        const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
        let name;
        if ((c.r - c.b) > 0.14 && c.r > 0.14 && c.r >= c.g) name = 'wood.png';   // saturated warm = timber
        else if (lum < 0.11)                                 name = 'metal.png';  // near-black structure
        else if (c.b >= c.r * 1.05 && lum < 0.33)            name = 'metal.png';  // cool dark = metal
        else                                                 name = 'wall_stone.png';
        let ru = 1, rv = 1;
        try {
            obj.geometry.computeBoundingBox();
            const bb = obj.geometry.boundingBox;
            const sx = (bb.max.x - bb.min.x) * Math.abs(obj.scale.x || 1);
            const sy = (bb.max.y - bb.min.y) * Math.abs(obj.scale.y || 1);
            const sz = (bb.max.z - bb.min.z) * Math.abs(obj.scale.z || 1);
            const dims = [sx, sy, sz].sort((a, b) => b - a);
            ru = Math.min(8, Math.max(1, Math.round(dims[0] / TEX_WORLD)));
            rv = Math.min(8, Math.max(1, Math.round(dims[1] / TEX_WORLD)));
        } catch (_) {}
        const tint = c.getHex();
        const clone = mat.clone();   // per-mesh so each gets its own repeat
        obj.material = clone;
        if (disposables) disposables.push(clone);   // free on room teardown
        _dsApplyRealTex(THREE, clone, name, ru, rv, tint);
    });
}

// ── Quake lightstyles ───────────────────────────────────────────────────────
// Quake animates lights with strings sampled at 10 Hz where each letter is a
// brightness: 'a' = 0 (dark) … 'm' = 1.0 (normal) … 'z' ≈ 2.0 (bright). The
// choppy stepped sampling — not a smooth sine — is exactly what makes a torch
// read as Quake. Strings are the canonical defaults from the Quake source
// (`fire`/`flicker` shimmer upward and never go dark, the way real torches do;
// `candle` drops to black for an eerie sputter).
const _DS_LIGHTSTYLES = {
    fire:    'mmnmmommnmmonqnmmommnonqnmmomnnmm',
    flicker: 'mmnmmommommnonmmonqnmmo',
    candle:  'mmmmmaaaaammmmmaaaaaabcdefgabcdefg',
};
// Sample a style at `tMs`, offset by `phase` index units, → multiplier in [0,2].
// A short linear blend between the two nearest 10 Hz samples keeps it lively
// without hard strobing on the bright steps.
function _dsSampleLightstyle(name, tMs, phase) {
    const s = _DS_LIGHTSTYLES[name] || 'm';
    const f = tMs * 0.01 + (phase || 0);   // 10 Hz: +1 index every 100 ms
    const i = Math.floor(f);
    const a = (s.charCodeAt(((i % s.length) + s.length) % s.length) - 97) / 12;
    const b = (s.charCodeAt((((i + 1) % s.length) + s.length) % s.length) - 97) / 12;
    return a + (b - a) * (f - i);
}

// ── Shared render target ────────────────────────────────────────────────────
// Every scene builder (hub, dungeon, and the diegetic rooms) renders the same
// 90s-crawler way: a fixed low-resolution WebGL target upscaled with pixelated
// CSS (the resolution is a design constant per ADR 0007, not a perf knob). This
// factory is the single source of truth for that render-target + canvas setup —
// the one place to touch when changing the upscale CSS or wiring diagnostics.
// scene/camera/fog stay with each builder since their fov, clip planes, and fog
// legitimately differ (the dungeon runs at Quake scale; the rooms don't).
function _dsRenderTarget(THREE, renderW, renderH) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    // Cache hardware max anisotropy so real-texture surfaces stay sharp at depth.
    try { _dsMaxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 1); } catch (_) {}
    // Scenes are authored against a 320×200 buffer for the retro aspect, but that
    // is far too coarse to read in-world text/labels on a modern display. Render
    // at an integer multiple of the authored size (same aspect → identical look,
    // just sharp), sized to the viewport and capped for performance. The chunky
    // procedural wall textures keep the retro feel regardless of buffer size.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.min((window.innerWidth || 1280) * dpr, 2560);
    const scale = Math.max(2, Math.min(8, Math.round(targetW / renderW)));
    renderer.setSize(renderW * scale, renderH * scale, false);
    renderer.setClearColor(0x000000);
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:auto;';
    _dsInstallPostFx(THREE, renderer);
    return { renderer, canvas };
}

// ── Palette-quantize + ordered-dither post pass ──────────────────────────────
// The one render upgrade that *reinforces* the retro look instead of breaking
// it: quantize the framebuffer to a coarse per-channel palette and hide the
// banding with a 4×4 Bayer dither locked to output pixels. Applied uniformly to
// every scene by wrapping the shared renderer's draw call, so the Hub, dungeon,
// and diegetic rooms all share one cohesive VGA-ish grain. Tunable here only.
const _DS_POSTFX_LEVELS = 16;     // quantization steps per channel (lower = chunkier)
function _dsInstallPostFx(THREE, renderer) {
    if (renderer.__dsPostFx) return;
    // 4×4 Bayer matrix → a tiny RGBA DataTexture (value replicated per channel),
    // sampled by output-pixel coords so the dither cell is a fixed 4px regardless
    // of upscale. Uint8 keeps it WebGL1-safe (no float-texture extension needed).
    const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const bytes = new Uint8Array(16 * 4);
    for (let i = 0; i < 16; i++) {
        const v = Math.round(((B[i] + 0.5) / 16) * 255);
        bytes[i * 4] = bytes[i * 4 + 1] = bytes[i * 4 + 2] = v; bytes[i * 4 + 3] = 255;
    }
    const bayer = new THREE.DataTexture(bytes, 4, 4, THREE.RGBAFormat);
    bayer.wrapS = bayer.wrapT = THREE.RepeatWrapping;
    bayer.magFilter = bayer.minFilter = THREE.NearestFilter;
    bayer.needsUpdate = true;

    const sz = new THREE.Vector2();
    renderer.getSize(sz);
    const rt = new THREE.WebGLRenderTarget(Math.max(1, sz.x), Math.max(1, sz.y), {
        minFilter: THREE.LinearFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
    });

    const quadScene = new THREE.Scene();
    const quadCam = new THREE.Camera();
    const mat = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: rt.texture }, tBayer: { value: bayer }, uLevels: { value: _DS_POSTFX_LEVELS } },
        depthTest: false, depthWrite: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: [
            'precision highp float;',
            'uniform sampler2D tDiffuse; uniform sampler2D tBayer; uniform float uLevels;',
            'varying vec2 vUv;',
            'void main(){',
            '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
            '  c = pow(clamp(c, 0.0, 1.0), vec3(0.4545));',      // linear → sRGB (the inserted RT bypassed auto-encode)
            // Mild cinematic grade + vignette, applied before the dither so the
            // quantizer spreads any gradient banding. Kept subtle so the coarse
            // VGA palette still reads as the dominant look.
            '  c = mix(c, c * c * (3.0 - 2.0 * c), 0.12);',      // gentle S-curve contrast
            '  c += vec3(0.015, 0.006, -0.006) * (1.0 - c);',    // warm the shadows a touch
            '  vec2 vc = vUv - 0.5;',
            '  float vig = smoothstep(0.85, 0.35, length(vc));', // 1 center → ~0.2 corners
            '  c *= mix(0.76, 1.0, vig);',                       // darken corners to focus the view
            '  float th = texture2D(tBayer, gl_FragCoord.xy / 4.0).r - 0.5;',
            '  float n = uLevels - 1.0;',
            '  c += th / uLevels;',                               // spread the quantization error
            '  c = floor(c * n + 0.5) / n;',                      // snap to the palette
            '  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);',
            '}',
        ].join('\n'),
    });
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

    const realRender = renderer.render.bind(renderer);
    let inPost = false;
    renderer.render = function (scene, camera) {
        if (inPost || scene === quadScene) { realRender(scene, camera); return; }
        renderer.getSize(sz);
        if (rt.width !== sz.x || rt.height !== sz.y) rt.setSize(Math.max(1, sz.x), Math.max(1, sz.y));
        inPost = true;
        try {
            renderer.setRenderTarget(rt);
            realRender(scene, camera);
            // Snapshot the SCENE's draw stats here — the quad pass below resets
            // renderer.info (autoReset), so a post-render read would only ever see
            // the 2-triangle fullscreen quad. Diagnostics read __dsSceneInfo.
            const ri = renderer.info.render;
            renderer.__dsSceneInfo = { triangles: ri.triangles, calls: ri.calls };
            renderer.setRenderTarget(null);
            realRender(quadScene, quadCam);
        } finally { inPost = false; }
    };
    renderer.__dsPostFx = { rt, mat, bayer, dispose() { rt.dispose(); mat.dispose(); bayer.dispose(); } };
}

// ── Quake first-person controller ───────────────────────────────────────────
// The reusable physics kernel ported from mrdoob/three-quake (in_web.js +
// pmove.js), lifted out of the dungeon builder so it can be tested in isolation
// and reused by any first-person scene. It owns the view-angle state, WASD
// intent, Pointer-Lock mouselook math, Quake ground physics (PM_Friction +
// PM_Accelerate), and the V_CalcBob / V_CalcRoll view feel. It does NOT own
// collision — the caller integrates `vel` against its own geometry each frame
// and zeroes a component on a wall hit. `eye` is the camera eye height in the
// caller's world units (Quake scale in the dungeon's case).
//
// Per-frame contract:  applyLook() → { wx, wz, wishspeed } = wishDir() →
//   accelerate(dt, wx, wz, wishspeed) → caller integrates+collides → set
//   camera.position.y = eye + viewBobRoll(dt) → caller does camera.rotation.set
//   using qc.pitch / qc.yaw / qc.viewRoll.
function _dsQuakeController(camera, opts) {
    const eye = (opts && opts.eye) || 0;
    const DEG2RAD = Math.PI / 180;
    // Authentic Quake: angle delta = mouse * sensitivity(3) * m_yaw/m_pitch(0.022).
    const LOOK_SENS = 0.022 * 3 * DEG2RAD;
    const PITCH_MAX = 80 * DEG2RAD;            // Quake clamps pitch to ~±80°
    // Literal Quake values — the world is sized to Quake units, so these are used
    // 1:1, not scaled. sv_maxspeed 320, sv_accelerate 10, sv_friction 4,
    // sv_stopspeed 100. Run: walk at cl_forwardspeed(200); +speed × cl_movespeedkey(2).
    const MOVE_MAXSPEED = 320, MOVE_ACCEL = 10, MOVE_FRICTION = 4;
    const MOVE_STOPSPEED = 100;
    const MOVE_WALKSPEED = 200, RUN_MULT = 2.0;
    // View bob — V_CalcBob: cl_bob 0.02, cl_bobcycle 0.6, cl_bobup 0.5.
    const CL_BOB = 0.02, CL_BOBCYCLE = 0.6, CL_BOBUP = 0.5;
    // View roll — V_CalcRoll: cl_rollangle 2°, cl_rollspeed 200.
    const CL_ROLLANGLE = 2.0, CL_ROLLSPEED = 200;

    camera.rotation.order = 'YXZ';

    return {
        yaw: 0, pitch: 0,                       // radians; yaw 0 faces -z
        vel: { x: 0, z: 0 },                    // floor-plane velocity (units/sec)
        keys: { f: false, b: false, l: false, r: false, run: false },
        mxAccum: 0, myAccum: 0,                 // unconsumed Pointer-Lock deltas
        bobTime: 0, viewRoll: 0,                // V_CalcBob accumulator; current roll (rad)

        reset() {
            this.yaw = 0; this.pitch = 0; this.vel.x = 0; this.vel.z = 0;
            this.mxAccum = 0; this.myAccum = 0; this.bobTime = 0; this.viewRoll = 0;
            this.keys.f = this.keys.b = this.keys.l = this.keys.r = this.keys.run = false;
            camera.position.set(0, eye, 0);
            camera.rotation.set(0, 0, 0);
        },

        clearKeys() {
            this.keys.f = this.keys.b = this.keys.l = this.keys.r = this.keys.run = false;
        },

        // Accumulate raw Pointer-Lock movement; applied (and cleared) by applyLook.
        addMouse(dx, dy) { this.mxAccum += dx || 0; this.myAccum += dy || 0; },

        // Apply accumulated mouse deltas to view angles (Quake), then clear them.
        applyLook() {
            if (this.mxAccum === 0 && this.myAccum === 0) return;
            this.yaw   -= this.mxAccum * LOOK_SENS;
            this.pitch -= this.myAccum * LOOK_SENS;
            if (this.pitch >  PITCH_MAX) this.pitch =  PITCH_MAX;
            if (this.pitch < -PITCH_MAX) this.pitch = -PITCH_MAX;
            this.mxAccum = 0; this.myAccum = 0;
        },

        // Map a keydown/keyup to a movement intent. Returns true if handled.
        setMoveKey(e, down) {
            switch (e.key) {
                case 'w': case 'W': case 'ArrowUp':    this.keys.f = down; return true;
                case 's': case 'S': case 'ArrowDown':  this.keys.b = down; return true;
                case 'a': case 'A': case 'ArrowLeft':  this.keys.l = down; return true;
                case 'd': case 'D': case 'ArrowRight': this.keys.r = down; return true;
                case 'Shift': this.keys.run = down; return true;   // +speed (run)
            }
            return false;
        },

        // Normalized wish-direction + wish-speed from the current keys + yaw.
        wishDir() {
            const fwd = (this.keys.f ? 1 : 0) - (this.keys.b ? 1 : 0);
            const strafe = (this.keys.r ? 1 : 0) - (this.keys.l ? 1 : 0);
            const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
            // forward = (-sinY, -cosY); right = (cosY, -sinY)
            let wx = -sinY * fwd + cosY * strafe;
            let wz = -cosY * fwd - sinY * strafe;
            const wlen = Math.hypot(wx, wz);
            let wishspeed = 0;
            if (wlen > 0) {
                wx /= wlen; wz /= wlen;
                wishspeed = Math.min(this.keys.run ? MOVE_WALKSPEED * RUN_MULT : MOVE_WALKSPEED, MOVE_MAXSPEED);
            }
            return { wx, wz, wishspeed };
        },

        // PM_Friction then PM_Accelerate on `vel` for this wish vector.
        accelerate(dt, wx, wz, wishspeed) {
            const speed = Math.hypot(this.vel.x, this.vel.z);
            if (speed > 0.0001) {
                const control = speed < MOVE_STOPSPEED ? MOVE_STOPSPEED : speed;
                const newspeed = Math.max(0, speed - control * MOVE_FRICTION * dt) / speed;
                this.vel.x *= newspeed; this.vel.z *= newspeed;
            } else { this.vel.x = 0; this.vel.z = 0; }
            if (wishspeed > 0) {
                const add = wishspeed - (this.vel.x * wx + this.vel.z * wz);
                if (add > 0) {
                    const accel = Math.min(MOVE_ACCEL * dt * wishspeed, add);
                    this.vel.x += accel * wx; this.vel.z += accel * wz;
                }
            }
        },

        // Advance the bob cycle + roll for this frame; returns the bob offset to
        // add to eye height. Call after collision so `vel` reflects wall hits.
        viewBobRoll(dt) {
            // V_CalcBob: cycle phase advances with real time (asymmetric via
            // cl_bobup), amplitude = speed × cl_bob, clamped.
            this.bobTime += dt;
            let cycle = (this.bobTime - Math.floor(this.bobTime / CL_BOBCYCLE) * CL_BOBCYCLE) / CL_BOBCYCLE;
            if (cycle < CL_BOBUP) cycle = Math.PI * cycle / CL_BOBUP;
            else cycle = Math.PI + Math.PI * (cycle - CL_BOBUP) / (1 - CL_BOBUP);
            const gs = Math.hypot(this.vel.x, this.vel.z);
            let bob = gs * CL_BOB;
            bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
            bob = Math.max(-7, Math.min(4, bob));
            // V_CalcRoll: bank into lateral velocity.
            const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
            let side = this.vel.x * cosY + this.vel.z * (-sinY);   // dot(velocity, right)
            const sign = side < 0 ? -1 : 1;
            side = Math.abs(side);
            const rollDeg = (side < CL_ROLLSPEED ? side * CL_ROLLANGLE / CL_ROLLSPEED : CL_ROLLANGLE) * sign;
            this.viewRoll = -rollDeg * DEG2RAD;   // negative: camera banks toward the strafe
            return bob;
        },
    };
}

// Shared first-person rig for the static side rooms (Wall of Fame, Archive,
// Hall of Records, Shop). Gives each the same Quake WASD + mouselook + box
// collision the Hub and Dungeon have, so every room is walkable rather than
// on-rails. The caller owns its scene/loop and just:
//   - calls walk.step(dt) inside its idle phase (after which it sets
//     camera.rotation from qc), and
//   - supplies callbacks: canMove(), interact(raycaster)->bool, onExit(), onEscape().
// Walking out the back of the room (toward +z, the entry the player arrived
// through) triggers onExit once; Escape calls onEscape. Returns { qc, step,
// detach, isLocked }.
function _dsAmbientVol() {
    const v = localStorage.getItem('ds_dun_ambient_vol');
    if (v == null) return 0.7;
    const n = parseFloat(v);
    return isNaN(n) ? 0.7 : Math.max(0, Math.min(1, n));
}
function _dsSetAmbientVol(v) {
    v = Math.max(0, Math.min(1, v));
    localStorage.setItem('ds_dun_ambient_vol', String(v));
    if (_dsDungeon && typeof _dsDungeon.setAmbientVolume === 'function') {
        _dsDungeon.setAmbientVolume(v);
    }
    if (_dsAudio) _dsAudio.setAmbientVol(v);
}

function _dsSfxVol() {
    var v = localStorage.getItem('ds_dun_sfx_vol');
    if (v == null) return 0.7;
    var n = parseFloat(v);
    return isNaN(n) ? 0.7 : Math.max(0, Math.min(1, n));
}
function _dsSetSfxVol(v) {
    v = Math.max(0, Math.min(1, v));
    localStorage.setItem('ds_dun_sfx_vol', String(v));
    if (_dsAudio) _dsAudio.setSfxVol(v);
}

// ── Shared audio system (Hub + Dungeon) ─────────────────────────────────────
// Procedural Web Audio API ambient bed, footsteps, stings, and room motifs.
// Created once in dsDungeonEnter, stopped in dsDungeonExit. Hub and dungeon
// scene transitions just call setRoomMotif() — no audio restart between rooms.
var _dsAudio = null;
(function() {
    var ctx = null;
    var ambiMaster = null;
    var sfxMaster = null;
    var ambiActive = false;
    var droneNodes = [];
    var windState = null;
    var moanTimer = null;
    var motifLayer = null;

    function init() {
        if (ctx) return true;
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return false; }
        ambiActive = true;

        ambiMaster = ctx.createGain();
        ambiMaster.gain.setValueAtTime(0, ctx.currentTime);
        ambiMaster.gain.linearRampToValueAtTime(_dsAmbientVol(), ctx.currentTime + 4);
        ambiMaster.connect(ctx.destination);

        sfxMaster = ctx.createGain();
        sfxMaster.gain.setValueAtTime(_dsSfxVol(), ctx.currentTime);
        sfxMaster.connect(ctx.destination);

        // Drone — two detuned sawtooths
        [55, 55.4].forEach(function(freq) {
            var osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = freq;
            var filt = ctx.createBiquadFilter();
            filt.type = 'lowpass';
            filt.frequency.value = 180;
            filt.Q.value = 4;
            var g = ctx.createGain();
            g.gain.value = 0.055;
            osc.connect(filt); filt.connect(g); g.connect(ambiMaster);
            osc.start();
            droneNodes.push({ osc: osc, filt: filt, gain: g });
        });

        // Wind — filtered noise with slow LFO on cutoff
        var bufLen = ctx.sampleRate * 3;
        var noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        var nd = noiseBuf.getChannelData(0);
        for (var i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;
        var noiseNode = ctx.createBufferSource();
        noiseNode.buffer = noiseBuf;
        noiseNode.loop = true;
        var windFilt = ctx.createBiquadFilter();
        windFilt.type = 'bandpass';
        windFilt.frequency.value = 280;
        windFilt.Q.value = 0.6;
        var windLFO = ctx.createOscillator();
        windLFO.frequency.value = 0.07;
        var windLFOG = ctx.createGain();
        windLFOG.gain.value = 130;
        windLFO.connect(windLFOG); windLFOG.connect(windFilt.frequency);
        var windG = ctx.createGain();
        windG.gain.value = 0.045;
        noiseNode.connect(windFilt); windFilt.connect(windG); windG.connect(ambiMaster);
        noiseNode.start(); windLFO.start();
        windState = { noise: noiseNode, filt: windFilt, lfo: windLFO, lfoG: windLFOG, gain: windG };

        // Motif layer — sine oscillator modulated by room type (starts silent)
        var mOsc = ctx.createOscillator();
        mOsc.type = 'sine';
        mOsc.frequency.value = 55;
        var mFilt = ctx.createBiquadFilter();
        mFilt.type = 'lowpass';
        mFilt.frequency.value = 80;
        mFilt.Q.value = 2;
        var mG = ctx.createGain();
        mG.gain.value = 0;
        mOsc.connect(mFilt); mFilt.connect(mG); mG.connect(ambiMaster);
        mOsc.start();
        motifLayer = { osc: mOsc, filt: mFilt, gain: mG };

        // Schedule moans
        function schedMoan() {
            if (!ambiActive) return;
            moanTimer = setTimeout(function() { moan(); schedMoan(); }, 9000 + Math.random() * 18000);
        }
        schedMoan();
        return true;
    }

    function moan() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var freq = 70 + Math.random() * 55;
            var dur = 2.5 + Math.random() * 1.5;
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.linearRampToValueAtTime(freq * (0.75 + Math.random() * 0.4), t + dur);
            var vib = ctx.createOscillator();
            vib.frequency.value = 3.5 + Math.random() * 3;
            var vibG = ctx.createGain();
            vibG.gain.value = 2.5;
            vib.connect(vibG); vibG.connect(osc.frequency);
            var g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.065, t + 0.9);
            g.gain.linearRampToValueAtTime(0, t + dur + 0.4);
            osc.connect(g); g.connect(ambiMaster);
            osc.start(t); vib.start(t);
            osc.stop(t + dur + 0.6); vib.stop(t + dur + 0.6);
        } catch(e) {}
    }

    function setRoomMotif(roomType) {
        if (!ctx || !ambiActive || !motifLayer) return;
        try {
            var t = ctx.currentTime;
            var freq, qVal, gVal;
            switch (roomType) {
                case 'boss':     freq = 68;  qVal = 10; gVal = 0.035; break;
                case 'shop':     freq = 110; qVal = 3;  gVal = 0.025; break;
                case 'rest':     freq = 50;  qVal = 8;  gVal = 0.02;  break;
                case 'treasure': freq = 88;  qVal = 6;  gVal = 0.03;  break;
                case 'mystery':  freq = 75;  qVal = 7;  gVal = 0.028; break;
                case 'elite':    freq = 62;  qVal = 9;  gVal = 0.04;  break;
                case 'forced':   freq = 55;  qVal = 4;  gVal = 0.015; break;
                default:         freq = 50;  qVal = 4;  gVal = 0;     break;
            }
            motifLayer.osc.frequency.setTargetAtTime(freq, t, 0.5);
            motifLayer.filt.Q.setTargetAtTime(qVal, t, 0.5);
            motifLayer.gain.gain.setTargetAtTime(gVal, t, 0.5);
        } catch(e) {}
    }

    function playFootstep(speedNorm) {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = (0.08 + (speedNorm || 0.5) * 0.12) * _dsSfxVol();
            // Low thump
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(120, t);
            osc.frequency.exponentialRampToValueAtTime(40, t + 0.08);
            var g = ctx.createGain();
            g.gain.setValueAtTime(vol, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
            osc.connect(g); g.connect(sfxMaster);
            osc.start(t); osc.stop(t + 0.15);
            // Gravel noise burst
            var bufLen = Math.floor(ctx.sampleRate * 0.06);
            var buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
            var data = buf.getChannelData(0);
            for (var i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 2);
            var src = ctx.createBufferSource();
            src.buffer = buf;
            var f = ctx.createBiquadFilter();
            f.type = 'highpass';
            f.frequency.value = 600;
            var sg = ctx.createGain();
            sg.gain.value = vol * 0.5;
            src.connect(f); f.connect(sg); sg.connect(sfxMaster);
            src.start(t);
        } catch(e) {}
    }

    function playDoorOpen() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = 0.15 * _dsSfxVol();
            // Stone grind — noise burst with sweeping bandpass
            var bufLen = Math.floor(ctx.sampleRate * 0.8);
            var buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
            var data = buf.getChannelData(0);
            for (var i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
            var src = ctx.createBufferSource();
            src.buffer = buf;
            var f = ctx.createBiquadFilter();
            f.type = 'bandpass';
            f.frequency.setValueAtTime(200, t);
            f.frequency.exponentialRampToValueAtTime(600, t + 0.4);
            f.frequency.exponentialRampToValueAtTime(150, t + 0.8);
            f.Q.value = 2;
            var g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(vol, t + 0.05);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
            src.connect(f); f.connect(g); g.connect(sfxMaster);
            src.start(t);
            // Low boom
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(80, t);
            osc.frequency.exponentialRampToValueAtTime(30, t + 0.4);
            var og = ctx.createGain();
            og.gain.setValueAtTime(vol * 0.6, t);
            og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
            osc.connect(og); og.connect(sfxMaster);
            osc.start(t); osc.stop(t + 0.6);
        } catch(e) {}
    }

    function playBossClear() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = 0.25 * _dsSfxVol();
            // Doom-style power chord: E2, B2, E3
            [82.4, 123.5, 164.8].forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                osc.type = 'square';
                osc.frequency.value = freq;
                var f = ctx.createBiquadFilter();
                f.type = 'lowpass';
                f.frequency.value = 400;
                var g = ctx.createGain();
                var start = t + i * 0.06;
                g.gain.setValueAtTime(0, start);
                g.gain.linearRampToValueAtTime(vol, start + 0.02);
                g.gain.setValueAtTime(vol * 0.7, start + 0.15);
                g.gain.exponentialRampToValueAtTime(0.001, start + 1.8);
                osc.connect(f); f.connect(g); g.connect(sfxMaster);
                osc.start(start); osc.stop(start + 2.0);
            });
            // Low thud
            var td = ctx.createOscillator();
            td.type = 'sine';
            td.frequency.setValueAtTime(40, t);
            td.frequency.exponentialRampToValueAtTime(15, t + 1.2);
            var tg = ctx.createGain();
            tg.gain.setValueAtTime(vol, t);
            tg.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
            td.connect(tg); tg.connect(sfxMaster);
            td.start(t); td.stop(t + 1.8);
        } catch(e) {}
    }

    // Quake-style menu blips. Short, dry, retro — a tight square "tick" on
    // move and a deeper two-step "chunk" on select. Gated behind sfx volume.
    function playMenuMove() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = 0.10 * _dsSfxVol();
            var osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(540, t);
            osc.frequency.exponentialRampToValueAtTime(680, t + 0.03);
            var g = ctx.createGain();
            g.gain.setValueAtTime(vol, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
            osc.connect(g); g.connect(sfxMaster);
            osc.start(t); osc.stop(t + 0.07);
        } catch(e) {}
    }

    function playMenuSelect() {
        if (!ctx || !ambiActive) return;
        try {
            var t = ctx.currentTime;
            var vol = 0.16 * _dsSfxVol();
            // Down-step thunk: bright tick then a low confirming square.
            [[760, 0, 0.04, 'square'], [180, 0.05, 0.18, 'square']].forEach(function(p) {
                var osc = ctx.createOscillator();
                osc.type = p[3];
                osc.frequency.setValueAtTime(p[0], t + p[1]);
                osc.frequency.exponentialRampToValueAtTime(p[0] * 0.6, t + p[1] + p[2]);
                var g = ctx.createGain();
                g.gain.setValueAtTime(vol, t + p[1]);
                g.gain.exponentialRampToValueAtTime(0.001, t + p[1] + p[2]);
                osc.connect(g); g.connect(sfxMaster);
                osc.start(t + p[1]); osc.stop(t + p[1] + p[2] + 0.02);
            });
        } catch(e) {}
    }

    function setAmbientVol(v) {
        if (!ctx || !ambiMaster) return;
        try { ambiMaster.gain.cancelScheduledValues(ctx.currentTime); ambiMaster.gain.setTargetAtTime(v, ctx.currentTime, 0.05); } catch(e) {}
    }

    function setSfxVol(v) {
        if (!ctx || !sfxMaster) return;
        try { sfxMaster.gain.cancelScheduledValues(ctx.currentTime); sfxMaster.gain.setTargetAtTime(v, ctx.currentTime, 0.05); } catch(e) {}
    }

    function stop() {
        ambiActive = false;
        clearTimeout(moanTimer);
        if (!ctx) return;
        try {
            ambiMaster.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
            sfxMaster.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
            setTimeout(function() { try { ctx.close(); } catch(e) {} ctx = null; }, 1400);
        } catch(e) {}
    }

    _dsAudio = {
        init: init,
        setRoomMotif: setRoomMotif,
        playFootstep: playFootstep,
        playDoorOpen: playDoorOpen,
        playBossClear: playBossClear,
        playMenuMove: playMenuMove,
        playMenuSelect: playMenuSelect,
        setAmbientVol: setAmbientVol,
        setSfxVol: setSfxVol,
        stop: stop,
    };
})();

// ── Generic menu renderer ────────────────────────────────────────────────────
// Renders into an overlay-sized panel. Keyboard nav (arrows / w-s / enter /
// escape) is captured at window level with stopPropagation so the dungeon's
// own keydown listener doesn't double-handle while a menu is up.
function _dsCloseMenu() {
    if (_dsActiveMenuKey) {
        window.removeEventListener('keydown', _dsActiveMenuKey, true);
        _dsActiveMenuKey = null;
    }
    const panel = document.getElementById('ds-dungeon-menu');
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
}

// ── Quake-styled menu chrome ──────────────────────────────────────────────────
// One-time <style> injection: the carved-bronze logo gradient, the iconic
// animated flame cursor (bob + flicker), the torch-glow vignette, and the
// item bevel. Shared by the hero main menu and every sub-menu so the whole
// dungeon UI reads as one gothic, torch-lit world rather than a web dialog.
function _dsInjectMenuCSS() {
    if (document.getElementById('ds-quake-menu-css')) return;
    const st = document.createElement('style');
    st.id = 'ds-quake-menu-css';
    st.textContent = `
    .ds-q-panel{font-family:'Times New Roman',Georgia,serif;color:#b89055;
        background:radial-gradient(120% 90% at 50% 0%,#2a1206 0%,#150a04 38%,#070402 78%,#000 100%);}
    .ds-q-title{font-weight:700;text-transform:uppercase;line-height:.92;
        letter-spacing:.06em;
        background:linear-gradient(180deg,#ffe9a8 0%,#e8b04a 34%,#9a5a16 70%,#5a3008 100%);
        -webkit-background-clip:text;background-clip:text;color:transparent;
        -webkit-text-fill-color:transparent;
        filter:drop-shadow(0 2px 0 #1a0c03) drop-shadow(0 0 14px rgba(232,160,64,.35));}
    .ds-q-kicker{font-family:'Times New Roman',Georgia,serif;text-transform:uppercase;
        font-weight:700;letter-spacing:.55em;color:#7a4a1c;
        text-shadow:0 1px 0 #000;}
    .ds-q-sub{font-family:'Courier New',monospace;text-transform:uppercase;
        letter-spacing:.22em;color:#8a6a3a;text-shadow:0 1px 2px #000;}
    .ds-q-item{position:relative;background:none;border:none;cursor:pointer;
        font-family:'Times New Roman',Georgia,serif;font-weight:700;
        text-transform:uppercase;letter-spacing:.18em;color:#9c7642;
        padding:6px 14px 6px 40px;text-align:left;display:block;width:100%;
        min-height:44px;line-height:1.1;
        transition:color .08s ease,text-shadow .08s ease,transform .08s ease;
        text-shadow:0 1px 0 #000;outline:none;}
    .ds-q-item:disabled{color:#4a3a26;cursor:default;text-shadow:none;}
    .ds-q-item.sel{color:#ffd24a;transform:translateX(2px);
        text-shadow:0 0 10px rgba(255,200,70,.6),0 1px 0 #2a1402;}
    .ds-q-item .ds-q-cursor{position:absolute;left:8px;top:50%;
        transform:translateY(-50%);opacity:0;color:#ffcb45;font-size:1.05em;
        text-shadow:0 0 8px #ff8c1a,0 0 16px #d4600a;
        animation:dsCursorBob .5s steps(2,jump-none) infinite,dsCursorFlick .12s steps(2) infinite;}
    .ds-q-item.sel .ds-q-cursor{opacity:1;}
    @keyframes dsCursorBob{0%{margin-left:0;}100%{margin-left:5px;}}
    @keyframes dsCursorFlick{0%{opacity:1;}100%{opacity:.72;}}
    .ds-q-footer{font-family:'Courier New',monospace;color:#5a4326;
        letter-spacing:.18em;text-shadow:0 1px 0 #000;}
    .ds-reticle{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        width:4px;height:4px;background:rgba(255,255,255,0.55);border-radius:50%;
        z-index:7;pointer-events:none;opacity:0;transition:opacity .15s ease;}
    .ds-reticle.ds-reticle-on{opacity:1;}
    `;
    document.head.appendChild(st);
}

function _dsMenuMove() { try { if (_dsAudio) _dsAudio.playMenuMove(); } catch(e) {} }
function _dsMenuSelect() { try { if (_dsAudio) _dsAudio.playMenuSelect(); } catch(e) {} }

function _dsRenderMenu(container, opts) {
    _dsInjectMenuCSS();
    if (_dsActiveMenuKey) {
        window.removeEventListener('keydown', _dsActiveMenuKey, true);
        _dsActiveMenuKey = null;
    }
    let panel = document.getElementById('ds-dungeon-menu');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'ds-dungeon-menu';
        container.appendChild(panel);
    }
    panel.className = 'ds-q-panel';
    panel.style.cssText = 'position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom));';

    const items = opts.items || [];
    let sel = items.findIndex(it => !it.disabled);
    if (sel < 0) sel = 0;

    const render = () => {
        const itemsHtml = items.map((it, i) => {
            const cur = i === sel;
            return `<button data-mi="${i}"${it.disabled ? ' disabled' : ''} class="ds-q-item${cur ? ' sel' : ''}" style="font-size:1.05rem;"><span class="ds-q-cursor" aria-hidden="true">&#9656;</span>${esc(it.label)}</button>`;
        }).join('');

        panel.innerHTML = `
            <div class="ds-q-title" style="font-size:clamp(1.4rem,5vw,2rem);letter-spacing:.14em;margin-bottom:6px;text-align:center;">${esc(opts.title || '')}</div>
            ${opts.subtitle ? `<div class="ds-q-sub" style="font-size:0.72rem;margin-bottom:30px;text-align:center;max-width:480px;">${esc(opts.subtitle)}</div>` : '<div style="margin-bottom:30px;"></div>'}
            ${opts.body ? `<div style="margin-bottom:24px;">${opts.body}</div>` : ''}
            <div style="display:flex;flex-direction:column;gap:2px;min-width:min(260px,90vw);">${itemsHtml}</div>
        `;
        if (typeof opts.afterRender === 'function') opts.afterRender(panel);
        panel.querySelectorAll('button[data-mi]').forEach(b => {
            const i = parseInt(b.dataset.mi, 10);
            b.addEventListener('mouseenter', () => { if (!items[i].disabled && sel !== i) { sel = i; _dsMenuMove(); render(); } });
            b.addEventListener('click', () => { if (!items[i].disabled) { _dsMenuSelect(); items[i].action(); } });
        });
    };

    const onKey = (e) => {
        if (e.key === 'ArrowDown' || e.key === 's') {
            for (let i = 0; i < items.length; i++) { sel = (sel + 1) % items.length; if (!items[sel].disabled) break; }
            _dsMenuMove(); render(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'ArrowUp' || e.key === 'w') {
            for (let i = 0; i < items.length; i++) { sel = (sel - 1 + items.length) % items.length; if (!items[sel].disabled) break; }
            _dsMenuMove(); render(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Enter' || e.key === ' ') {
            if (!items[sel].disabled) { _dsMenuSelect(); items[sel].action(); }
            e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Escape' && typeof opts.onCancel === 'function') {
            opts.onCancel();
            e.preventDefault(); e.stopPropagation();
        }
    };
    window.addEventListener('keydown', onKey, true);
    _dsActiveMenuKey = onKey;
    render();
}

// ── Specific menus ───────────────────────────────────────────────────────────
// The Quake-1-styled main menu — the dungeon's front door. A torch-lit ember
// backdrop, a carved-bronze "THE DAILY" wordmark, the animated flame cursor,
// and the classic vertical option list. ENTER walks the player into the Hub
// (the 3D lobby), exactly as dsDungeonEnter used to do directly.
function _dsShowMainMenu(overlay, d) {
    _dsInjectMenuCSS();
    if (_dsActiveMenuKey) { window.removeEventListener('keydown', _dsActiveMenuKey, true); _dsActiveMenuKey = null; }
    if (_dsAudio) { _dsAudio.init(); _dsAudio.setRoomMotif('hub'); }

    let panel = document.getElementById('ds-dungeon-menu');
    if (!panel) { panel = document.createElement('div'); panel.id = 'ds-dungeon-menu'; overlay.appendChild(panel); }
    panel.className = 'ds-q-panel';
    panel.style.cssText = 'position:absolute;inset:0;z-index:8;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:max(28px,env(safe-area-inset-top)) 24px max(28px,env(safe-area-inset-bottom));';

    const hasProgress = !!localStorage.getItem('ds_dun_node_' + d.date) || !!localStorage.getItem('ds_dun_pos_' + d.date);
    const enterHub = () => {
        _dsCloseMenu();
        if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
        if (_dsHub) { _dsHub.destroy(); _dsHub = null; }
        overlay.innerHTML = '';
        if (_dsAudio) { _dsAudio.init(); _dsAudio.setRoomMotif('hub'); }
        try {
            _dsHub = _dsBuildHub(_dsTHREE, overlay, d);
            _dsHub.start();
        } catch (e) {
            console.error('[daily] hub scene failed to build:', e);
            _dsHub = null;
            _dsShowDungeonFatal(overlay, 'Dungeon failed to load',
                'Something went wrong building the 3D scene' + (e && e.message ? ' (' + e.message + ').' : '.') + ' Try reloading Slopsmith.');
        }
    };

    const items = [
        { label: hasProgress ? 'CONTINUE' : 'DESCEND', action: enterHub },
    ];
    if (hasProgress) {
        items.push({ label: 'RESTART RUN', action: () => _dsConfirmRestart(overlay, d, () => _dsShowMainMenu(overlay, d)) });
    }
    items.push({ label: 'OPTIONS', action: () => _dsShowOptionsMenu(overlay, () => _dsShowMainMenu(overlay, d)) });
    // QUIT leaves the Daily entirely and returns to the host library — the
    // legacy 2D map is not a valid destination in dungeon mode.
    items.push({ label: 'QUIT', action: () => { _dsCloseMenu(); dsDungeonExit(); try { window.showScreen('home'); } catch (e) {} } });

    let sel = 0;
    const subtitle = `${d.day_name || ''}${d.modifier?.label ? ' • ' + d.modifier.label : ''}`;

    panel.innerHTML = `
        <canvas id="ds-mm-bg" style="position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;"></canvas>
        <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;width:100%;max-width:560px;">
            <div class="ds-q-kicker" style="font-size:clamp(.6rem,2.4vw,.82rem);margin-bottom:6px;">The</div>
            <div class="ds-q-title" style="font-size:clamp(3.2rem,15vw,6.4rem);margin-bottom:8px;">DAILY</div>
            <div class="ds-q-sub" style="font-size:clamp(.6rem,2.6vw,.78rem);text-align:center;margin-bottom:clamp(24px,6vh,48px);max-width:90%;">${esc(subtitle)}</div>
            <div id="ds-mm-items" role="menu" aria-label="Main menu" style="display:flex;flex-direction:column;gap:2px;width:min(280px,82vw);"></div>
        </div>
        <div class="ds-q-footer" style="position:absolute;left:max(16px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));z-index:1;font-size:.6rem;">&#8593;&#8595; SELECT &#8226; ENTER CONFIRM</div>
        <div class="ds-q-footer" style="position:absolute;right:max(16px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:1;font-size:.6rem;">DAY #${esc(String(d.day_number || ''))}</div>
    `;

    const itemsWrap = panel.querySelector('#ds-mm-items');
    const renderItems = () => {
        itemsWrap.innerHTML = items.map((it, i) =>
            `<button data-mi="${i}" role="menuitem" tabindex="${i === sel ? 0 : -1}" class="ds-q-item${i === sel ? ' sel' : ''}" style="font-size:clamp(1.05rem,4vw,1.3rem);"><span class="ds-q-cursor" aria-hidden="true">&#9656;</span>${esc(it.label)}</button>`
        ).join('');
        itemsWrap.querySelectorAll('button[data-mi]').forEach(b => {
            const i = parseInt(b.dataset.mi, 10);
            b.addEventListener('mouseenter', () => { if (sel !== i) { sel = i; _dsMenuMove(); renderItems(); } });
            b.addEventListener('click', () => { _dsMenuSelect(); items[i].action(); });
        });
        const cur = itemsWrap.querySelector('.ds-q-item.sel');
        if (cur) { try { cur.focus({ preventScroll: true }); } catch (e) {} }
    };
    renderItems();

    const onKey = (e) => {
        if (e.key === 'ArrowDown' || e.key === 's') {
            sel = (sel + 1) % items.length; _dsMenuMove(); renderItems(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'ArrowUp' || e.key === 'w') {
            sel = (sel - 1 + items.length) % items.length; _dsMenuMove(); renderItems(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Enter' || e.key === ' ') {
            _dsMenuSelect(); items[sel].action(); e.preventDefault(); e.stopPropagation();
        }
    };
    window.addEventListener('keydown', onKey, true);
    _dsActiveMenuKey = onKey;

    _dsMainMenuFx(panel.querySelector('#ds-mm-bg'), panel);
}

// Torch-lit ember backdrop for the main menu. Embers drift up through a warm
// glow; a flickering top torch-light pulses the scene. Self-terminates when
// the panel leaves the DOM (so _dsCloseMenu's node removal stops the loop) and
// honours prefers-reduced-motion by drawing a single static frame.
function _dsMainMenuFx(canvas, panel) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    let embers = [];
    const resize = () => {
        const r = canvas.getBoundingClientRect();
        W = Math.max(1, r.width); H = Math.max(1, r.height);
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const target = Math.round(W * H / 26000);
        while (embers.length < target) embers.push(mkEmber(true));
        if (embers.length > target) embers.length = target;
    };
    function mkEmber(spawnAnywhere) {
        return {
            x: Math.random() * W,
            y: spawnAnywhere ? Math.random() * H : H + 8,
            r: 0.6 + Math.random() * 1.8,
            vy: 8 + Math.random() * 22,
            vx: (Math.random() - 0.5) * 10,
            life: 0, max: 4 + Math.random() * 5,
            hue: 24 + Math.random() * 16,
        };
    }
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas); else window.addEventListener('resize', resize);
    resize();

    let last = performance.now();
    const drawFrame = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        ctx.clearRect(0, 0, W, H);
        // Flickering torch glow from the top.
        const flick = reduce ? 0.85 : 0.7 + Math.random() * 0.3;
        const g = ctx.createRadialGradient(W * 0.5, -H * 0.15, 0, W * 0.5, -H * 0.15, H * 1.05);
        g.addColorStop(0, `rgba(255,150,50,${0.22 * flick})`);
        g.addColorStop(0.4, `rgba(180,80,20,${0.10 * flick})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        // Embers.
        ctx.globalCompositeOperation = 'lighter';
        for (const e of embers) {
            e.life += dt; e.y -= e.vy * dt; e.x += e.vx * dt + Math.sin(e.life * 2) * 0.3;
            const a = Math.max(0, 1 - e.life / e.max) * (0.5 + Math.random() * 0.5);
            ctx.beginPath();
            ctx.fillStyle = `hsla(${e.hue},100%,60%,${a})`;
            ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill();
            if (e.y < -10 || e.life > e.max) Object.assign(e, mkEmber(false));
        }
        ctx.globalCompositeOperation = 'source-over';
        // Bottom vignette to seat the menu.
        const vg = ctx.createLinearGradient(0, H * 0.55, 0, H);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = vg; ctx.fillRect(0, H * 0.55, W, H * 0.45);

        if (!panel.isConnected) { if (ro) ro.disconnect(); else window.removeEventListener('resize', resize); return; }
        if (reduce) return; // single static frame
        requestAnimationFrame(drawFrame);
    };
    requestAnimationFrame(drawFrame);
}

// Back-compat shim: older call sites referenced the bare title menu. Route
// them through the new Quake main menu.
function _dsShowTitleMenu(overlay, d) { _dsShowMainMenu(overlay, d); }

function _dsShowPauseMenu(d) {
    const overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) return;
    _dsRenderMenu(overlay, {
        title: 'PAUSED',
        items: [
            { label: 'RESUME', action: _dsCloseMenu },
            { label: 'RESTART RUN', action: () => _dsConfirmRestart(overlay, d, () => _dsShowPauseMenu(d)) },
            { label: 'OPTIONS', action: () => _dsShowOptionsMenu(overlay, () => _dsShowPauseMenu(d)) },
            { label: 'EXIT', action: () => {
                _dsCloseMenu();
                if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
                const _pauseOv = document.getElementById('ds-dungeon-overlay');
                let hubData = d;
                if (_dsHistoricalDate && _dsTodaySnapshot) {
                    hubData = _dsTodaySnapshot;
                    _dsData = _dsTodaySnapshot;
                    _dsHistoricalDate = null;
                }
                if (_dsTHREE && _pauseOv) { _pauseOv.innerHTML = ''; _dsHub = _dsBuildHub(_dsTHREE, _pauseOv, hubData); _dsHub.start(); }
            } },
        ],
        onCancel: _dsCloseMenu,
    });
}

function _dsConfirmRestart(overlay, d, onCancel) {
    _dsRenderMenu(overlay, {
        title: 'RESTART RUN?',
        subtitle: 'Wipes today\'s cleared songs, committed lanes, node actions, and reverses tokens earned today. Long-term inventory and purchases are kept.',
        items: [
            { label: 'YES, RESTART', action: () => _dsDoRestart(overlay, d) },
            { label: 'CANCEL', action: onCancel },
        ],
        onCancel,
    });
}

async function _dsDoRestart(overlay, d) {
    // Show a brief in-flight state so the user sees feedback during the round-trip.
    _dsRenderMenu(overlay, {
        title: 'RESETTING...',
        subtitle: 'Wiping today\'s run from the server.',
        items: [],
    });
    try {
        await fetch('/api/plugins/the_daily/reset-day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ install_id: dsInstallId() }),
        });
    } catch (e) {
        // Fall through — even if the endpoint failed, we still want a clean
        // local restart so the user isn't stuck on the spinner.
    }
    // Refetch /today so the new dungeon sees the wiped state (cleared/committed
    // sets are now empty server-side).
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/today'));
        const txt = await r.text();
        const fresh = txt ? JSON.parse(txt) : null;
        if (fresh && _dsData && !fresh.error) {
            Object.assign(_dsData, fresh);
        }
    } catch (e) {}
    // Reset the saved camera position. With cleared_node_ids now empty, start()
    // will treat this as fresh STS and show the lane picker again.
    localStorage.removeItem('ds_dun_node_' + d.date);
    dsRefreshTokens();
    _dsStartRun(overlay, d);
}

// Quake-style options screen. Up/Down (or W/S) moves between rows; Left/Right
// (or A/D) adjusts the selected slider in 5% steps; Enter selects BACK; Escape
// backs out. The whole screen is keyboard-driven (matching Quake's options),
// and the slider tracks also accept mouse click + drag.
function _dsShowOptionsMenu(overlay, onBack) {
    _dsInjectMenuCSS();
    if (_dsActiveMenuKey) { window.removeEventListener('keydown', _dsActiveMenuKey, true); _dsActiveMenuKey = null; }

    let panel = document.getElementById('ds-dungeon-menu');
    if (!panel) { panel = document.createElement('div'); panel.id = 'ds-dungeon-menu'; overlay.appendChild(panel); }
    panel.className = 'ds-q-panel';
    panel.style.cssText = 'position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom));';

    const STEP = 0.05;
    const rows = [
        { kind: 'slider', label: 'AMBIENT', aria: 'Ambient volume', get: _dsAmbientVol, set: _dsSetAmbientVol },
        { kind: 'slider', label: 'SFX', aria: 'SFX volume', get: _dsSfxVol, set: _dsSetSfxVol },
        { kind: 'action', label: 'BACK', action: onBack },
    ];
    let sel = 0;

    panel.innerHTML = `
        <div class="ds-q-title" style="font-size:clamp(1.6rem,6vw,2.4rem);letter-spacing:.16em;margin-bottom:34px;text-align:center;">OPTIONS</div>
        <div id="ds-opt-rows" role="menu" aria-label="Options" style="display:flex;flex-direction:column;gap:8px;width:min(360px,88vw);"></div>
    `;
    const wrap = panel.querySelector('#ds-opt-rows');

    const rowHtml = (r, i) => {
        const cls = `ds-q-item${i === sel ? ' sel' : ''}`;
        if (r.kind === 'slider') {
            const pct = Math.round(r.get() * 100);
            return `<div data-row="${i}" class="${cls}" role="slider" tabindex="${i === sel ? 0 : -1}"
                        aria-label="${esc(r.aria || r.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
                        style="display:flex;align-items:center;gap:10px;font-size:.85rem;letter-spacing:.14em;cursor:pointer;">
                    <span class="ds-q-cursor" aria-hidden="true">&#9656;</span>
                    <span style="flex:0 0 5em;white-space:nowrap;">${esc(r.label)}</span>
                    <span class="ds-opt-track" data-track="${i}" style="position:relative;flex:1;height:10px;background:#1c1108;border:1px solid #3a2510;border-radius:5px;overflow:hidden;cursor:pointer;">
                        <span class="ds-opt-fill" style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:linear-gradient(180deg,#ffd24a,#9a5a16);"></span>
                    </span>
                    <span class="ds-opt-val" style="flex:0 0 2.8em;text-align:right;color:#e8b04a;">${pct}%</span>
                </div>`;
        }
        return `<button data-row="${i}" role="menuitem" tabindex="${i === sel ? 0 : -1}" class="${cls}" style="font-size:1.05rem;margin-top:14px;"><span class="ds-q-cursor" aria-hidden="true">&#9656;</span>${esc(r.label)}</button>`;
    };

    const setSlider = (i, v, sound) => {
        const r = rows[i];
        v = Math.max(0, Math.min(1, Math.round(v / STEP) * STEP));
        r.set(v);
        const pct = Math.round(v * 100);
        const el = wrap.querySelector(`[data-row="${i}"]`);
        if (el) {
            el.setAttribute('aria-valuenow', pct);
            const fill = el.querySelector('.ds-opt-fill'); if (fill) fill.style.width = pct + '%';
            const val = el.querySelector('.ds-opt-val'); if (val) val.textContent = pct + '%';
        }
        if (sound) _dsMenuMove();
    };

    const focusRow = () => {
        wrap.querySelectorAll('[data-row]').forEach((el) => {
            const i = parseInt(el.dataset.row, 10);
            el.classList.toggle('sel', i === sel);
            el.setAttribute('tabindex', i === sel ? '0' : '-1');
        });
        const cur = wrap.querySelector('[data-row].sel');
        if (cur) { try { cur.focus({ preventScroll: true }); } catch (e) {} }
    };

    const render = () => {
        wrap.innerHTML = rows.map(rowHtml).join('');
        wrap.querySelectorAll('[data-row]').forEach((el) => {
            const i = parseInt(el.dataset.row, 10);
            el.addEventListener('mouseenter', () => { if (sel !== i) { sel = i; _dsMenuMove(); focusRow(); } });
        });
        wrap.querySelectorAll('button[data-row]').forEach((b) => {
            const i = parseInt(b.dataset.row, 10);
            b.addEventListener('click', () => { _dsMenuSelect(); rows[i].action(); });
        });
        wrap.querySelectorAll('.ds-opt-track').forEach((track) => {
            const i = parseInt(track.dataset.track, 10);
            const setFromX = (clientX) => {
                const rect = track.getBoundingClientRect();
                setSlider(i, (clientX - rect.left) / rect.width, false);
            };
            track.addEventListener('pointerdown', (e) => {
                sel = i; focusRow();
                track.setPointerCapture(e.pointerId);
                setFromX(e.clientX); e.preventDefault();
            });
            track.addEventListener('pointermove', (e) => {
                if (track.hasPointerCapture(e.pointerId)) setFromX(e.clientX);
            });
        });
    };

    const onKey = (e) => {
        const k = e.key;
        if (k === 'ArrowDown' || k === 's') {
            sel = (sel + 1) % rows.length; _dsMenuMove(); focusRow();
        } else if (k === 'ArrowUp' || k === 'w') {
            sel = (sel - 1 + rows.length) % rows.length; _dsMenuMove(); focusRow();
        } else if ((k === 'ArrowLeft' || k === 'a') && rows[sel].kind === 'slider') {
            setSlider(sel, rows[sel].get() - STEP, true);
        } else if ((k === 'ArrowRight' || k === 'd') && rows[sel].kind === 'slider') {
            setSlider(sel, rows[sel].get() + STEP, true);
        } else if (k === 'Enter' || k === ' ') {
            if (rows[sel].kind === 'action') { _dsMenuSelect(); rows[sel].action(); }
        } else if (k === 'Escape') {
            onBack();
        } else { return; }
        e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    _dsActiveMenuKey = onKey;
    render();
    focusRow();
}

function _dsStartRun(overlay, d) {
    _dsCloseMenu();
    if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
    overlay.innerHTML = '';
    _dsDungeon = _dsBuildDungeon(_dsTHREE, overlay, d);
    _dsDungeon.start();
}

// ── Load historical day's dungeon from Archive ──────────────────────────────
async function _dsLoadHistoricalDungeon(dateStr, overlayEl) {
    try {
        const resp = await fetch(dsApiUrl(`/api/plugins/the_daily/setlist/${dateStr}`));
        const text = await resp.text();
        const data = text ? JSON.parse(text) : null;
        if (!data || data.error) {
            console.error('[daily] failed to load historical date:', data?.error);
            return false;
        }
        _dsTodaySnapshot = _dsData;
        _dsHistoricalDate = dateStr;
        _dsData = data;
        // /setlist/{date} returns the map but not per-player node progress
        // (available/committed/cleared are absent), so without this the dungeon
        // sees zero available entrances and skips the lane picker. Treat an
        // Archive run as a fresh replay: seed the row-0 entrances as available.
        if (!data.available_node_ids || !data.available_node_ids.length) {
            const row0 = ((data.map && data.map.nodes) || []).filter(n => (n.row || 0) === 0).map(n => n.id);
            data.available_node_ids = row0;
            data.committed_node_ids = [];
            data.cleared_node_ids = [];
            data.locked_node_ids = data.locked_node_ids || [];
        }
        // The Archive calendar lives in the Hub now, so tear the Hub down before
        // starting the historical run (otherwise its rAF loop + input listeners
        // keep running alongside the dungeon and the run never cleanly starts).
        if (_dsHub) { _dsHub.destroy(); _dsHub = null; }
        if (_dsArchiveRoom) { _dsArchiveRoom.destroy(); _dsArchiveRoom = null; }
        overlayEl.innerHTML = '';
        _dsStartRun(overlayEl, data);
        return true;
    } catch (e) {
        console.error('[daily] failed to load historical dungeon:', e);
        return false;
    }
}

// ── Diegetic surface utility ───────────────────────────────────────────────────
// Creates a canvas-textured PlaneGeometry mesh. `draw(ctx, w, h)` is called
// to populate the canvas; `surface.refresh()` re-runs it (e.g. when data changes).
// If `raycasterObjects` is passed, the mesh is pushed onto it for future hit-testing.
function _dsCreateDiegeticSurface(THREE, opts) {
    const { scene, position, rotation, size, draw, raycasterObjects, resolution, linearFilter } = opts;
    const [pw, ph] = size;
    const rw = (resolution && resolution[0]) || 256;
    const rh = (resolution && resolution[1]) || 180;
    const canvas = document.createElement('canvas');
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = texture.magFilter = linearFilter ? THREE.LinearFilter : THREE.NearestFilter;

    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
    const geometry = new THREE.PlaneGeometry(pw, ph);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    scene.add(mesh);

    if (raycasterObjects) raycasterObjects.push(mesh);

    function refresh() {
        ctx.clearRect(0, 0, rw, rh);
        draw(ctx, rw, rh);
        texture.needsUpdate = true;
    }
    refresh();

    function dispose() {
        scene.remove(mesh);
        geometry.dispose();
        material.dispose();
        texture.dispose();
    }

    return { mesh, refresh, dispose };
}

// ── Passage builder (diegetic doorway with sealed/unsealed state) ────────────
function _dsBuildPassage(THREE, opts) {
    const { scene, id, label, x, y, z, sealed, raycasterObjects, passageMeshes } = opts;
    const group = new THREE.Group();

    const frameMat = new THREE.MeshLambertMaterial({ color: 0x080808 });
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.5), frameMat);
    frame.position.set(0, 0, 0.01);
    group.add(frame);

    const fillMat = new THREE.MeshLambertMaterial({
        color: sealed ? 0x000000 : 0x1d4ed8,
        emissive: sealed ? 0x000000 : 0x0a1840,
    });
    fillMat.userData.noAutoTex = true;   // seal/unseal toggles this by reference
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), fillMat);
    fill.position.set(0, 0, 0.02);
    group.add(fill);
    if (passageMeshes) passageMeshes.set(fill, id);

    const lc = document.createElement('canvas');
    lc.width = 128; lc.height = 48;
    const lctx = lc.getContext('2d');
    lctx.font = 'bold 13px monospace';
    lctx.fillStyle = sealed ? '#555' : '#e8c040';
    lctx.textAlign = 'center';
    lctx.textBaseline = 'middle';
    lctx.fillText(label, 64, 24);
    const lTex = new THREE.CanvasTexture(lc);
    lTex.minFilter = lTex.magFilter = THREE.NearestFilter;
    const lMat = new THREE.MeshBasicMaterial({ map: lTex, transparent: true });
    const lMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), lMat);
    lMesh.position.set(0, 1.5, 0.03);
    group.add(lMesh);

    let gateMesh = null;
    if (sealed) {
        gateMesh = _dsBuildGateMesh(THREE);
        if (gateMesh) { gateMesh.position.set(0, 0, 0.04); group.add(gateMesh); }
    }

    group.position.set(x, y, z);
    scene.add(group);

    if (raycasterObjects) raycasterObjects.push(fill);

    function setSealed(newSealed) {
        if (newSealed) {
            fillMat.color.setHex(0x000000);
            fillMat.emissive.setHex(0x000000);
            if (!gateMesh) {
                gateMesh = _dsBuildGateMesh(THREE);
                if (gateMesh) { gateMesh.position.set(0, 0, 0.04); group.add(gateMesh); }
            }
        } else {
            fillMat.color.setHex(0x1d4ed8);
            fillMat.emissive.setHex(0x0a1840);
            if (gateMesh) {
                group.remove(gateMesh);
                gateMesh.geometry.dispose();
                gateMesh.material.dispose();
                gateMesh = null;
            }
        }
        lctx.clearRect(0, 0, 128, 48);
        lctx.font = 'bold 13px monospace';
        lctx.fillStyle = newSealed ? '#555' : '#e8c040';
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.fillText(label, 64, 24);
        lTex.needsUpdate = true;
    }

    function dispose() {
        scene.remove(group);
        frameMat.dispose();
        fillMat.dispose();
        lMat.dispose();
        lTex.dispose();
        if (gateMesh) { gateMesh.geometry.dispose(); gateMesh.material.dispose(); }
    }

    return { id, x, setSealed, dispose };
}

function _dsBuildGateMesh(THREE) {
    const gc = document.createElement('canvas');
    gc.width = 64; gc.height = 64;
    const gctx = gc.getContext('2d');
    gctx.strokeStyle = '#330000';
    gctx.lineWidth = 5;
    gctx.beginPath();
    gctx.moveTo(12, 12); gctx.lineTo(52, 52);
    gctx.moveTo(52, 12); gctx.lineTo(12, 52);
    gctx.stroke();
    gctx.lineWidth = 3;
    gctx.strokeStyle = '#220000';
    for (let gy = 8; gy < 56; gy += 10) {
        gctx.beginPath();
        gctx.moveTo(4, gy); gctx.lineTo(60, gy);
        gctx.stroke();
    }
    const gTex = new THREE.CanvasTexture(gc);
    gTex.minFilter = gTex.magFilter = THREE.NearestFilter;
    const gMat = new THREE.MeshBasicMaterial({ map: gTex, transparent: true, opacity: 0.5 });
    return new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), gMat);
}

function _dsPlayThud() {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var t = ctx.currentTime;
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(80, t);
        osc.frequency.exponentialRampToValueAtTime(30, t + 0.15);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.3, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.3);
    } catch(e) {}
}

// Creative "vault antechamber" dressing for the Hub: stone pillars + ceiling
// beams give it architecture; a glowing ritual dais with flanking braziers and
// an animated energy rift make the TODAY descent portal the hero; drifting
// embers and hanging banners add atmosphere. Purely decorative — no collision
// or interaction changes. Returns { tick(now, dt), dispose() }.
function _dsDressHub(THREE, scene, dims) {
    const { HW, HH, HL, HY, doorZ } = dims;
    const floorY = HY - HH / 2, ceilY = HY + HH / 2;
    const group = new THREE.Group(); scene.add(group);
    const mats = [], geos = [], texs = [], tickers = [];
    const keepGeo = (g) => { geos.push(g); return g; };
    const keepMat = (m) => { mats.push(m); return m; };

    // small canvas-texture helper
    const canvasTex = (size, paint) => {
        const c = document.createElement('canvas'); c.width = c.height = size;
        paint(c.getContext('2d'), size);
        const t = new THREE.CanvasTexture(c); t.minFilter = t.magFilter = THREE.LinearFilter; texs.push(t); return t;
    };

    // ── Architecture: pillars (2 per side wall, clear of the z −2.5/−7 stations)
    const stoneCol = keepMat(new THREE.MeshLambertMaterial({ map: _dsStoneBasic(THREE, 48, 40, 30, 1, 2) }));
    const beamMat = keepMat(new THREE.MeshLambertMaterial({ color: 0x110b06 }));
    const pillarGeo = keepGeo(new THREE.CylinderGeometry(0.2, 0.27, HH - 0.3, 10));
    const blockGeo = keepGeo(new THREE.BoxGeometry(0.6, 0.22, 0.6));
    [-1, 1].forEach((side) => {
        [-0.6, -9.4].forEach((pz) => {
            const px = side * (HW / 2 - 0.33);
            const col = new THREE.Mesh(pillarGeo, stoneCol); col.position.set(px, HY, pz); group.add(col);
            const base = new THREE.Mesh(blockGeo, stoneCol); base.position.set(px, floorY + 0.11, pz); group.add(base);
            const cap = new THREE.Mesh(blockGeo, stoneCol); cap.position.set(px, ceilY - 0.11, pz); group.add(cap);
        });
    });
    // Ceiling beams across the width
    const beamGeo = keepGeo(new THREE.BoxGeometry(HW, 0.22, 0.24));
    [-1.5, -5.5, -9.5].forEach((bz) => { const b = new THREE.Mesh(beamGeo, beamMat); b.position.set(0, ceilY - 0.12, bz); group.add(b); });

    // ── Ritual dais ring on the floor before the portal (pulsing) ──
    const daisMat = keepMat(new THREE.MeshBasicMaterial({ color: 0x3a72c8, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const dais = new THREE.Mesh(keepGeo(new THREE.RingGeometry(0.95, 1.4, 44)), daisMat);
    dais.rotation.x = -Math.PI / 2; dais.position.set(0, floorY + 0.02, doorZ + 1.7); group.add(dais);
    tickers.push((now) => { daisMat.opacity = 0.32 + Math.sin(now * 0.004) * 0.2; });

    // ── Energy rift over the TODAY passage (hero) ──
    const swirlTex = canvasTex(128, (ctx, s) => {
        const cx = s / 2;
        const g = ctx.createRadialGradient(cx, cx, 2, cx, cx, cx);
        g.addColorStop(0, 'rgba(180,220,255,0.95)'); g.addColorStop(0.35, 'rgba(70,140,255,0.55)');
        g.addColorStop(0.7, 'rgba(30,70,200,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cx, cx, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(200,230,255,0.7)'; ctx.lineWidth = 2;
        for (let a = 0; a < 5; a++) {
            ctx.beginPath();
            for (let r = 4; r < cx; r += 2) { const th = a * 1.256 + r * 0.13; const x = cx + Math.cos(th) * r, y = cx + Math.sin(th) * r; r === 4 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
            ctx.globalAlpha = 0.4; ctx.stroke(); ctx.globalAlpha = 1;
        }
    });
    const riftMat = keepMat(new THREE.MeshBasicMaterial({ map: swirlTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }));
    const rift = new THREE.Mesh(keepGeo(new THREE.PlaneGeometry(1.55, 1.55)), riftMat);
    rift.position.set(0, HY + 0.1, doorZ + 0.07); group.add(rift);
    const riftLight = new THREE.PointLight(0x5a9bff, 1.4, 6); riftLight.position.set(0, HY, doorZ + 0.9); group.add(riftLight);
    tickers.push((now) => { rift.rotation.z += 0.006; riftMat.opacity = 0.65 + Math.sin(now * 0.005) * 0.2; riftLight.intensity = 1.2 + Math.sin(now * 0.006) * 0.5; });

    // ── Braziers flanking the dais ──
    const flameTex = canvasTex(64, (ctx, s) => {
        const g = ctx.createRadialGradient(s / 2, s * 0.62, 2, s / 2, s * 0.55, s * 0.5);
        g.addColorStop(0, 'rgba(255,240,180,0.95)'); g.addColorStop(0.4, 'rgba(255,150,40,0.8)');
        g.addColorStop(0.8, 'rgba(180,50,10,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(s / 2, s * 0.55, s * 0.28, s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    });
    const trimMat = keepMat(new THREE.MeshLambertMaterial({ color: 0x6a5226, emissive: 0x1c1305 }));
    const stemGeo = keepGeo(new THREE.CylinderGeometry(0.06, 0.1, 0.8, 8));
    const bowlGeo = keepGeo(new THREE.CylinderGeometry(0.24, 0.1, 0.16, 12));
    const flameGeo = keepGeo(new THREE.PlaneGeometry(0.46, 0.62));
    [-1.7, 1.7].forEach((bx) => {
        const stem = new THREE.Mesh(stemGeo, stoneCol); stem.position.set(bx, floorY + 0.4, doorZ + 2.0); group.add(stem);
        const bowl = new THREE.Mesh(bowlGeo, trimMat); bowl.position.set(bx, floorY + 0.85, doorZ + 2.0); group.add(bowl);
        const flameMat = keepMat(new THREE.MeshBasicMaterial({ map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        const flame = new THREE.Mesh(flameGeo, flameMat); flame.position.set(bx, floorY + 1.12, doorZ + 2.0); group.add(flame);
        const light = new THREE.PointLight(0xff8a30, 2.0, 5); light.position.set(bx, floorY + 1.2, doorZ + 2.0); group.add(light);
        tickers.push((now) => { const f = 0.82 + Math.sin(now * 0.018 + bx * 3) * 0.1 + Math.random() * 0.08; flame.scale.set(0.92 + (f - 0.82), f, 1); flameMat.opacity = 0.85 * f; light.intensity = 1.8 * f; });
    });

    // ── Hanging banners flanking the portal ──
    const bannerTex = canvasTex(64, (ctx, s) => {
        ctx.fillStyle = '#16243f'; ctx.fillRect(0, 0, s, s);
        ctx.strokeStyle = '#caa14a'; ctx.lineWidth = 3; ctx.strokeRect(4, 4, s - 8, s - 8);
        ctx.fillStyle = '#e8c040'; ctx.beginPath();
        ctx.moveTo(s / 2, 14); ctx.lineTo(s - 16, s / 2); ctx.lineTo(s / 2, s - 14); ctx.lineTo(16, s / 2); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#16243f'; ctx.beginPath(); ctx.arc(s / 2, s / 2, 7, 0, Math.PI * 2); ctx.fill();
    });
    const bannerMat = keepMat(new THREE.MeshLambertMaterial({ map: bannerTex, transparent: true, emissive: 0x0a1424, emissiveMap: bannerTex }));
    const bannerGeo = keepGeo(new THREE.PlaneGeometry(0.62, 1.7));
    [-2.5, 2.5].forEach((bx) => { const bn = new THREE.Mesh(bannerGeo, bannerMat); bn.position.set(bx, HY + 0.35, doorZ + 0.06); group.add(bn); });

    // ── Showcase display cases around each wall station ──
    // Ornate framing for the four tablets: stone backing + accent trim border
    // with corner studs, a pediment cap and base shelf, and two flanking sconce
    // flames — turning each tablet into a lit reliquary display. The interactive
    // canvas surface itself is built in the Hub's station blocks; this only
    // dresses around it (group placed at the surface centre + rotation).
    function addShowcase({ x, y, z, rotY, w, h, accent }) {
        const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rotY; group.add(g);
        const back = new THREE.Mesh(keepGeo(new THREE.PlaneGeometry(w + 0.55, h + 0.7)), stoneCol);
        back.position.set(0, 0, -0.03); g.add(back);
        const tw = w + 0.2, th = h + 0.2;
        const trimMat = keepMat(new THREE.MeshLambertMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.25 }));
        const studMat = keepMat(new THREE.MeshLambertMaterial({ color: 0x8a6a30, emissive: 0x140e04 }));
        const barTop = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(tw + 0.14, 0.08, 0.05)), trimMat); barTop.position.set(0, th / 2, 0.02); g.add(barTop);
        const barBot = barTop.clone(); barBot.position.set(0, -th / 2, 0.02); g.add(barBot);
        const barL = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.08, th, 0.05)), trimMat); barL.position.set(-tw / 2, 0, 0.02); g.add(barL);
        const barR = barL.clone(); barR.position.set(tw / 2, 0, 0.02); g.add(barR);
        const studGeo = keepGeo(new THREE.BoxGeometry(0.11, 0.11, 0.07));
        [[-tw / 2, th / 2], [tw / 2, th / 2], [-tw / 2, -th / 2], [tw / 2, -th / 2]].forEach(([sx, sy]) => {
            const s = new THREE.Mesh(studGeo, studMat); s.position.set(sx, sy, 0.04); g.add(s);
        });
        const ped = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(tw + 0.18, 0.15, 0.13)), stoneCol); ped.position.set(0, th / 2 + 0.15, 0.05); g.add(ped);
        const pedTrim = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(tw + 0.18, 0.03, 0.14)), trimMat); pedTrim.position.set(0, th / 2 + 0.07, 0.06); g.add(pedTrim);
        const shelf = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(tw + 0.26, 0.1, 0.2)), stoneCol); shelf.position.set(0, -th / 2 - 0.12, 0.09); g.add(shelf);
        [-1, 1].forEach((side) => {
            const sx = side * (tw / 2 + 0.16);
            const bracket = new THREE.Mesh(keepGeo(new THREE.BoxGeometry(0.05, 0.05, 0.16)), studMat); bracket.position.set(sx, -0.12, 0.1); g.add(bracket);
            const fMat = keepMat(new THREE.MeshBasicMaterial({ map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
            const flame = new THREE.Mesh(keepGeo(new THREE.PlaneGeometry(0.22, 0.3)), fMat); flame.position.set(sx, 0.04, 0.2); g.add(flame);
            tickers.push((now) => { const f = 0.8 + Math.sin(now * 0.02 + sx * 5 + z) * 0.12 + Math.random() * 0.08; flame.scale.set(0.92, f, 1); fMat.opacity = 0.85 * f; });
        });
    }
    const _scx = HW / 2 - 0.05;
    addShowcase({ x: -_scx, y: 0.5, z: -2.5, rotY: Math.PI / 2,  w: 2.8, h: 2.2, accent: 0xc9a14a });
    addShowcase({ x: -_scx, y: 0.5, z: -7.0, rotY: Math.PI / 2,  w: 2.8, h: 2.2, accent: 0xd8923a });
    addShowcase({ x:  _scx, y: 0.5, z: -2.5, rotY: -Math.PI / 2, w: 2.8, h: 2.2, accent: 0xc9a14a });
    addShowcase({ x:  _scx, y: 0.5, z: -7.0, rotY: -Math.PI / 2, w: 2.8, h: 2.2, accent: 0x9a6ad0 });

    // ── Drifting embers (sparse Points field) ──
    const N = 150;
    const epos = new Float32Array(N * 3), evel = new Float32Array(N);
    const rx = () => (Math.random() * 2 - 1) * (HW / 2 - 0.7);
    const rz = () => doorZ + 0.7 + Math.random() * (HL - 1.6);
    for (let i = 0; i < N; i++) { epos[i*3] = rx(); epos[i*3+1] = floorY + Math.random() * HH; epos[i*3+2] = rz(); evel[i] = 0.12 + Math.random() * 0.3; }
    const eg = keepGeo(new THREE.BufferGeometry()); eg.setAttribute('position', new THREE.BufferAttribute(epos, 3));
    const em = keepMat(new THREE.PointsMaterial({ color: 0xff9444, size: 0.05, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    const embers = new THREE.Points(eg, em); group.add(embers);
    tickers.push((now, dt) => {
        const p = eg.attributes.position.array;
        for (let i = 0; i < N; i++) {
            p[i*3+1] += evel[i] * dt;
            p[i*3] += Math.sin(now * 0.001 + i) * 0.0009;
            if (p[i*3+1] > ceilY) { p[i*3] = rx(); p[i*3+1] = floorY; p[i*3+2] = rz(); }
        }
        eg.attributes.position.needsUpdate = true;
    });

    return {
        tick: (now, dt) => { for (const t of tickers) t(now, dt || 0.016); },
        dispose: () => {
            scene.remove(group);
            geos.forEach((g) => { try { g.dispose(); } catch (e) {} });
            mats.forEach((m) => { try { m.dispose(); } catch (e) {} });
            texs.forEach((t) => { try { t.dispose(); } catch (e) {} });
        },
    };
}

// ── Hub (ThreeJS first-person chamber — entry point for The Daily) ────────────
function _dsBuildHub(THREE, overlay, d) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 10, HH = 3.5, HL = 12, HY = 0.35;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];

    const state = { phase: 'idle', moveTween: 0, rafId: null, moveStartZ: 0 };

    const { renderer, canvas } = _dsRenderTarget(THREE, RENDER_W, RENDER_H);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 10, 16);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    const ambientLight = new THREE.AmbientLight(0x221109);
    scene.add(ambientLight);
    const torch1 = new THREE.PointLight(0xff6622, 2.2, 10);
    torch1.position.set(-2.5, 1.2, -3);
    scene.add(torch1);
    const torch2 = new THREE.PointLight(0xff6622, 1.8, 10);
    torch2.position.set(2.5, 1.2, -7);
    scene.add(torch2);
    // TODAY descend-portal glow (back-centre).
    const passageGlow = new THREE.PointLight(0x1d4ed8, 2.5, 8);
    passageGlow.position.set(0, HY, -(HL - 2));
    scene.add(passageGlow);
    // Per-station accent lights along the side walls (positions match the
    // station blocks below): PASSPORT/ARCHIVE left, WALL OF FAME/SHOP right.
    const passportGlow = new THREE.PointLight(0xd4a044, 2.5, 7);
    passportGlow.position.set(-3.8, 0.5, -2.5);
    scene.add(passportGlow);
    const archiveGlow = new THREE.PointLight(0xffaa55, 2.5, 7);
    archiveGlow.position.set(-3.8, 0.5, -7.0);
    scene.add(archiveGlow);
    const wofGlow = new THREE.PointLight(0xe8c040, 2.5, 7);
    wofGlow.position.set(3.8, 0.5, -2.5);
    scene.add(wofGlow);
    const shopGlow = new THREE.PointLight(0x7c3aed, 2.5, 7);
    shopGlow.position.set(3.8, 0.5, -7.0);
    scene.add(shopGlow);

    function stoneTexture(r, g, b, ru, rv) {
        return _dsStoneBasic(THREE, r, g, b, ru, rv);
    }

    const wallMat     = new THREE.MeshLambertMaterial({ map: stoneTexture(38, 32, 28, 3, 1) });
    const floorMat    = new THREE.MeshLambertMaterial({ map: stoneTexture(25, 22, 18, 2, 4) });
    const ceilMat     = new THREE.MeshLambertMaterial({ map: stoneTexture(18, 16, 14, 2, 4) });
    const backMat     = new THREE.MeshLambertMaterial({ map: stoneTexture(22, 18, 15, 2, 1) });
    const darkWallMat = new THREE.MeshLambertMaterial({ color: 0x040404 });
    // Swap in real COMTEX stone once decoded (tinted down to stay dungeon-dark).
    _dsApplyRealTex(THREE, wallMat,  'wall_stone.png',    4, 2, 0x6c655c);
    _dsApplyRealTex(THREE, floorMat, 'floor_granite.png', 3, 6, 0x5a564f);
    _dsApplyRealTex(THREE, ceilMat,  'floor_plate.png',   3, 6, 0x3a3732);
    _dsApplyRealTex(THREE, backMat,  'wall_castle.png',   3, 2, 0x6c645a);

    const addPlane = (geo, mat, rx, ry, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.set(rx, ry, 0);
        m.position.set(px, py, pz);
        scene.add(m);
    };
    addPlane(new THREE.PlaneGeometry(HW, HL), floorMat,  -Math.PI/2, 0,          0,     HY-HH/2, -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HW, HL), ceilMat,    Math.PI/2, 0,          0,     HY+HH/2, -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,    0,  Math.PI/2, -HW/2,  HY,    -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HL, HH), wallMat,    0, -Math.PI/2,  HW/2,  HY,    -HL/2+1);
    addPlane(new THREE.PlaneGeometry(HW, HH), backMat,    0,  Math.PI,    0,     HY,     1.5);
    addPlane(new THREE.PlaneGeometry(HW, HH), darkWallMat, 0, 0,          0,     HY,    -(HL - 0.4));

    const doorZ = -(HL - 0.45);
    const passages = {};
    const passageMeshes = new Map();

    function buildPassage(id, label, xPos, sealed) {
        const p = _dsBuildPassage(THREE, {
            scene, id, label,
            x: xPos, y: HY, z: doorZ,
            sealed,
            raycasterObjects,
            passageMeshes,
        });
        passages[id] = p;
    }

    buildPassage('today', 'TODAY', 0, false);
    // ARCHIVE / WALL OF FAME / PASSPORT / SHOP are no longer passages to separate
    // rooms — each is now an in-hub diegetic station (see the station blocks
    // below), walkable with the Hub's Quake movement. Only TODAY (descend into
    // the run) and the exit door remain as passages.
    // _dsBossJustCompleted still drives the in-Hub boss celebration (see
    // triggerBossCelebration); captured here for the dismiss handler.
    let wofUnsealPending = _dsBossJustCompleted;

    // ── In-hub interactive sections ──────────────────────────────────────────
    // The former side rooms are being folded into the Hub as diegetic stations
    // you walk up to and use in-world (click the surface; crosshair when locked).
    // Each entry: { interact(raycaster)->bool, dispose() }.
    const hubSections = [];

    // Archive calendar station (replaces _dsBuildArchiveAntechamber). A wall
    // tablet where the ARCHIVE passage used to be: < / > pick a past UTC day,
    // CONFIRM descends into that day's dungeon.
    {
        const _CAL_EPOCH = new Date('2026-04-22T00:00:00Z');
        const _calNow = new Date();
        const _calTodayUTC = new Date(Date.UTC(_calNow.getUTCFullYear(), _calNow.getUTCMonth(), _calNow.getUTCDate()));
        const _calYesterday = new Date(_calTodayUTC); _calYesterday.setUTCDate(_calYesterday.getUTCDate() - 1);
        let _calSel = _calYesterday < _CAL_EPOCH ? new Date(_CAL_EPOCH) : _calYesterday;
        const _calStr = (dd) => dd.toISOString().slice(0, 10);
        const _calAdd = (dd, n) => { const r = new Date(dd); r.setUTCDate(r.getUTCDate() + n); return r; };
        let _calMod = null;            // modifier label for the selected day ('' = none, null = loading)
        const _calModCache = {};
        let _calModReq = 0;

        const calSurface = _dsCreateDiegeticSurface(THREE, {
            scene, raycasterObjects,
            position: [-(HW / 2 - 0.05), 0.5, -7.0],
            rotation: [0, Math.PI / 2, 0],
            size: [2.8, 2.2],
            resolution: [512, 360], linearFilter: true,
            draw: (ctx, w, h) => {
                const selStr = _calStr(_calSel);
                const canPrev = _calSel > _CAL_EPOCH;
                const canNext = _calSel < _calTodayUTC;
                ctx.fillStyle = '#332414'; ctx.fillRect(0, 0, w, h);
                const sd = ctx.getImageData(0, 0, w, h);
                for (let i = 0; i < sd.data.length; i += 4) { const n = (Math.random() * 10 - 5) | 0; sd.data[i] += n; sd.data[i+1] += n; sd.data[i+2] += n; }
                ctx.putImageData(sd, 0, 0);
                ctx.strokeStyle = '#7a5630'; ctx.lineWidth = Math.max(4, h * 0.018); ctx.strokeRect(10, 10, w - 20, h - 20);
                ctx.textAlign = 'center';
                ctx.font = `bold ${Math.round(h * 0.12)}px monospace`; ctx.fillStyle = '#caa86a'; ctx.textBaseline = 'top';
                ctx.fillText('ARCHIVE', w / 2, h * 0.07);
                ctx.textBaseline = 'middle';
                const midY = h * 0.46;
                ctx.font = `bold ${Math.round(h * 0.22)}px monospace`;
                ctx.fillStyle = canPrev ? '#e6bd64' : '#4a4030'; ctx.fillText('‹', w * 0.12, midY);
                ctx.fillStyle = canNext ? '#e6bd64' : '#4a4030'; ctx.fillText('›', w * 0.88, midY);
                ctx.font = `bold ${Math.round(h * 0.13)}px monospace`; ctx.fillStyle = '#ffd97a'; ctx.fillText(selStr, w / 2, midY);
                // Modifier name for the selected day (… while loading).
                const modTxt = _calMod === null ? '…' : (_calMod || '');
                if (modTxt) { ctx.font = `bold ${Math.round(h * 0.058)}px monospace`; ctx.fillStyle = '#c9a060'; ctx.fillText(modTxt.toUpperCase().slice(0, 24), w / 2, h * 0.63); }
                const bw = w * 0.52, bh = h * 0.15, bx = (w - bw) / 2, by = h * 0.79;
                ctx.fillStyle = '#3c2c16'; ctx.fillRect(bx, by, bw, bh);
                ctx.strokeStyle = '#caa86a'; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, bh);
                ctx.font = `bold ${Math.round(h * 0.085)}px monospace`; ctx.fillStyle = '#ffd97a'; ctx.fillText('CONFIRM', w / 2, by + bh / 2);
            },
        });
        // Look up the selected day's modifier name (cached; stale responses ignored).
        function fetchCalMod() {
            const date = _calStr(_calSel);
            if (Object.prototype.hasOwnProperty.call(_calModCache, date)) { _calMod = _calModCache[date]; calSurface.refresh(); return; }
            _calMod = null; calSurface.refresh();
            const req = ++_calModReq;
            fetch(dsApiUrl('/api/plugins/the_daily/setlist/' + date))
                .then((r) => r.text())
                .then((t) => {
                    const data = t ? JSON.parse(t) : null;
                    const label = (data && !data.error && data.modifier && data.modifier.label) ? data.modifier.label : '';
                    _calModCache[date] = label;
                    if (req === _calModReq && !destroyed) { _calMod = label; calSurface.refresh(); }
                })
                .catch(() => { if (req === _calModReq && !destroyed) { _calMod = ''; calSurface.refresh(); } });
        }
        fetchCalMod();
        const calChange = (dir) => { const nx = _calAdd(_calSel, dir); if (nx < _CAL_EPOCH || nx > _calTodayUTC) return; _calSel = nx; calSurface.refresh(); fetchCalMod(); };
        const calConfirm = () => {
            if (state.phase !== 'idle') return;
            state.phase = 'loading';
            _dsLoadHistoricalDungeon(_calStr(_calSel), overlay).then((ok) => { if (!ok && !destroyed) state.phase = 'idle'; });
        };
        hubSections.push({
            interact: (rc) => {
                for (const hit of rc.intersectObjects([calSurface.mesh])) {
                    if (hit.object === calSurface.mesh && hit.uv) {
                        // CanvasTexture flipY inverts uv.y vs canvas-y: the
                        // canvas-bottom CONFIRM button reads as high uy here.
                        const ux = hit.uv.x, uy = 1 - hit.uv.y;
                        if (uy >= 0.78) calConfirm();
                        else if (uy > 0.22) { if (ux < 0.3) calChange(-1); else if (ux > 0.7) calChange(1); }
                        return true;
                    }
                }
                return false;
            },
            dispose: () => { calSurface.dispose(); },
        });
    }

    // Shop station (replaces _dsBuildShopRoom). A purple market tablet where the
    // SHOP passage was: rows of items, click BUY. Tokens shown top-right.
    {
        const shopState = { items: [], tokens: 0, loading: true, error: null, buying: false };
        const BUY_HITS = [];
        function drawShop(ctx, w, h) {
            ctx.fillStyle = '#190a28'; ctx.fillRect(0, 0, w, h);
            const sd = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < sd.data.length; i += 4) { const n = (Math.random() * 10 - 5) | 0; sd.data[i] += n; sd.data[i+1] += n; sd.data[i+2] += n; }
            ctx.putImageData(sd, 0, 0);
            ctx.strokeStyle = '#6a3a9a'; ctx.lineWidth = Math.max(4, h * 0.018); ctx.strokeRect(10, 10, w - 20, h - 20);
            const pad = w * 0.05;
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.font = `bold ${Math.round(h * 0.085)}px monospace`; ctx.fillStyle = '#d8b050';
            ctx.fillText('🏪 SHOP', pad, h * 0.09);
            ctx.textAlign = 'right'; ctx.fillStyle = '#ffd24a';
            ctx.fillText('🪙 ' + shopState.tokens, w - pad, h * 0.09);
            ctx.strokeStyle = '#4a2a6a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pad, h * 0.165); ctx.lineTo(w - pad, h * 0.165); ctx.stroke();
            const big = (t, c) => { ctx.font = `bold ${Math.round(h * 0.07)}px monospace`; ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, w / 2, h / 2); };
            if (shopState.loading) { big('Loading…', '#9a8aaa'); return; }
            if (shopState.error) { big(shopState.error, '#c66'); return; }
            BUY_HITS.length = 0;
            const top = h * 0.20, rowH = h * 0.122, btnW = w * 0.22, btnX = w - pad - btnW;
            const maxRows = Math.floor((h * 0.96 - top) / rowH);
            const n = Math.min(shopState.items.length, maxRows);
            for (let i = 0; i < n; i++) {
                const item = shopState.items[i]; const y0 = top + i * rowH;
                if (i % 2 === 0) { ctx.fillStyle = 'rgba(70, 36, 96, 0.45)'; ctx.fillRect(pad - 4, y0, w - 2 * pad + 8, rowH - 4); }
                ctx.textAlign = 'left';
                ctx.font = `bold ${Math.round(h * 0.058)}px monospace`; ctx.textBaseline = 'alphabetic';
                ctx.fillStyle = item.owned ? '#8a7a9a' : '#f0e6ff'; ctx.fillText(item.name.substring(0, 18), pad, y0 + rowH * 0.42);
                ctx.font = `${Math.round(h * 0.04)}px monospace`; ctx.fillStyle = '#9a86b2'; ctx.fillText((item.description || item.type || '').substring(0, 26), pad, y0 + rowH * 0.78);
                const cost = item.discounted_cost ?? item.cost;
                ctx.font = `bold ${Math.round(h * 0.05)}px monospace`; ctx.textAlign = 'right'; ctx.fillStyle = '#ffd24a'; ctx.fillText('🪙' + cost, btnX - 8, y0 + rowH * 0.55);
                const by = y0 + rowH * 0.14, bh = rowH * 0.66;
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                if (item.owned) {
                    ctx.fillStyle = item.equipped ? '#22512a' : '#3a3a44'; ctx.fillRect(btnX, by, btnW, bh);
                    ctx.strokeStyle = item.equipped ? '#5aa05a' : '#5a5a6a'; ctx.lineWidth = 1.5; ctx.strokeRect(btnX, by, btnW, bh);
                    ctx.font = `bold ${Math.round(h * 0.042)}px monospace`; ctx.fillStyle = item.equipped ? '#9fe89f' : '#aaa';
                    ctx.fillText(item.equipped ? 'EQUIPPED' : 'OWNED', btnX + btnW / 2, by + bh / 2);
                } else if (!item.affordable) {
                    ctx.fillStyle = '#3a1c1c'; ctx.fillRect(btnX, by, btnW, bh);
                    ctx.strokeStyle = '#6a3434'; ctx.lineWidth = 1.5; ctx.strokeRect(btnX, by, btnW, bh);
                    ctx.font = `bold ${Math.round(h * 0.04)}px monospace`; ctx.fillStyle = '#c66';
                    ctx.fillText('NOT ENOUGH', btnX + btnW / 2, by + bh / 2);
                } else {
                    ctx.fillStyle = '#3a1f5e'; ctx.fillRect(btnX, by, btnW, bh);
                    ctx.strokeStyle = '#8a4ad0'; ctx.lineWidth = 1.5; ctx.strokeRect(btnX, by, btnW, bh);
                    ctx.font = `bold ${Math.round(h * 0.055)}px monospace`; ctx.fillStyle = '#d0a8ff'; ctx.fillText('BUY', btnX + btnW / 2, by + bh / 2);
                    BUY_HITS.push({ itemId: item.id, x1: btnX / w, x2: (btnX + btnW) / w, y1: y0 / h, y2: (y0 + rowH) / h });
                }
            }
        }
        const shopSurface = _dsCreateDiegeticSurface(THREE, {
            scene, raycasterObjects,
            position: [HW / 2 - 0.05, 0.5, -7.0], rotation: [0, -Math.PI / 2, 0], size: [2.8, 2.2],
            resolution: [512, 360], linearFilter: true, draw: drawShop,
        });
        function loadShop() {
            shopState.loading = true; shopState.error = null; shopSurface.refresh();
            fetch(dsApiUrl('/api/plugins/the_daily/shop'), { headers: { 'X-Install-Id': dsInstallId() } })
                .then((r) => r.text())
                .then((text) => { if (destroyed) return; const data = text ? JSON.parse(text) : {}; if (data.error) { shopState.error = data.error; shopState.loading = false; shopSurface.refresh(); return; } shopState.items = data.items || []; shopState.tokens = data.tokens || 0; shopState.loading = false; shopSurface.refresh(); })
                .catch(() => { if (destroyed) return; shopState.loading = false; shopState.error = 'Network error'; shopSurface.refresh(); });
        }
        function buyItem(itemId) {
            if (shopState.buying) return; shopState.buying = true; shopSurface.refresh();
            fetch(dsApiUrl('/api/plugins/the_daily/shop/buy'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() }, body: JSON.stringify({ item_id: itemId }) })
                .then((r) => r.text())
                .then((text) => { if (destroyed) return; shopState.buying = false; const data = text ? JSON.parse(text) : {}; if (data.error) { shopState.error = data.error; shopSurface.refresh(); return; } loadShop(); })
                .catch(() => { if (destroyed) return; shopState.buying = false; shopState.error = 'Network error'; shopSurface.refresh(); });
        }
        loadShop();
        hubSections.push({
            interact: (rc) => {
                for (const hit of rc.intersectObjects([shopSurface.mesh])) {
                    if (hit.object === shopSurface.mesh && hit.uv) {
                        if (shopState.loading || shopState.buying) return true;
                        // CanvasTexture flipY: BUY_HITS use canvas-y fractions, so invert uv.y.
                        const cx = hit.uv.x, cy = 1 - hit.uv.y;
                        for (const b of BUY_HITS) { if (cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2) { buyItem(b.itemId); break; } }
                        return true;
                    }
                }
                return false;
            },
            dispose: () => { shopSurface.dispose(); },
        });
    }

    // Passport station (replaces _dsBuildHallOfRecords). Display-only tablet:
    // lifetime totals + a month completion grid. Fed by /passport.
    {
        const pState = { data: null, loaded: false };
        const ppSurface = _dsCreateDiegeticSurface(THREE, {
            scene, raycasterObjects,
            position: [-(HW / 2 - 0.05), 0.5, -2.5], rotation: [0, Math.PI / 2, 0], size: [2.8, 2.2],
            resolution: [512, 360], linearFilter: true,
            draw: (ctx, w, h) => {
                ctx.fillStyle = '#282015'; ctx.fillRect(0, 0, w, h);
                const sd = ctx.getImageData(0, 0, w, h);
                for (let i = 0; i < sd.data.length; i += 4) { const n = (Math.random() * 10 - 5) | 0; sd.data[i] += n; sd.data[i+1] += n; sd.data[i+2] += n; }
                ctx.putImageData(sd, 0, 0);
                ctx.strokeStyle = '#7a5630'; ctx.lineWidth = Math.max(4, h * 0.018); ctx.strokeRect(10, 10, w - 20, h - 20);
                const pad = w * 0.05;
                ctx.font = `bold ${Math.round(h * 0.085)}px monospace`; ctx.fillStyle = '#e8c040'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                ctx.fillText('PASSPORT', w / 2, h * 0.05);
                if (!pState.loaded || !pState.data) { ctx.font = `bold ${Math.round(h * 0.07)}px monospace`; ctx.fillStyle = '#9a8a6a'; ctx.textBaseline = 'middle'; ctx.fillText('Loading…', w / 2, h / 2); return; }
                const t = pState.data.totals || {};
                const items = [['DAILIES', t.total_dailies || 0], ['STREAK', t.current_streak || 0], ['BEST', t.longest_streak || 0], ['TOKENS', t.lifetime_tokens_earned || 0]];
                const cw = w / 2, top = h * 0.27, rh = h * 0.16;
                items.forEach((it, i) => {
                    const cx = (i % 2) * cw + cw / 2, cy = top + Math.floor(i / 2) * rh;
                    ctx.font = `bold ${Math.round(h * 0.11)}px monospace`; ctx.fillStyle = '#ffd24a'; ctx.textBaseline = 'middle'; ctx.fillText(String(it[1]), cx, cy);
                    ctx.font = `bold ${Math.round(h * 0.04)}px monospace`; ctx.fillStyle = '#a8905c'; ctx.fillText(it[0], cx, cy + h * 0.065);
                });
                ctx.strokeStyle = '#5a472a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pad, h * 0.6); ctx.lineTo(w - pad, h * 0.6); ctx.stroke();
                const days = pState.data.days || [];
                const byMonth = {}; days.forEach((dd) => { const ym = dd.date.slice(0, 7); (byMonth[ym] = byMonth[ym] || []).push(dd); });
                const months = Object.keys(byMonth).sort().slice(-2);
                const cellSize = w * 0.048, gap = w * 0.008; let curY = h * 0.66;
                ctx.textBaseline = 'top';
                months.forEach((ym) => {
                    ctx.font = `bold ${Math.round(h * 0.042)}px monospace`; ctx.fillStyle = '#a8905c'; ctx.textAlign = 'left'; ctx.fillText(ym, pad, curY); curY += h * 0.055;
                    let col = 0;
                    byMonth[ym].forEach((dd) => {
                        if (col >= 14) { col = 0; curY += cellSize + gap; }
                        const x = pad + col * (cellSize + gap); const done = dd.boss_done;
                        ctx.fillStyle = done ? '#3a7a3a' : '#1c1810'; ctx.fillRect(x, curY, cellSize, cellSize);
                        ctx.strokeStyle = done ? '#6aaa6a' : '#33301f'; ctx.lineWidth = 1; ctx.strokeRect(x, curY, cellSize, cellSize); col++;
                    });
                    curY += cellSize + gap + h * 0.02;
                });
            },
        });
        fetch(dsApiUrl('/api/plugins/the_daily/passport'), { headers: { 'X-Install-Id': dsInstallId() } })
            .then((r) => r.text())
            .then((text) => { if (destroyed) return; const data = text ? JSON.parse(text) : null; pState.data = (data && !data.error) ? data : null; pState.loaded = true; ppSurface.refresh(); })
            .catch(() => { if (destroyed) return; pState.loaded = true; ppSurface.refresh(); });
        hubSections.push({ interact: () => false, dispose: () => { ppSurface.dispose(); } });
    }

    // Wall of Fame station (replaces _dsBuildWofRoom). Leaderboard stone tablet
    // where the WOF passage was: scroll names with ▲/▼; click the board (once
    // today's run is complete) to sign via a centered panel. Fed by /leaderboard
    // + /sign. wofSignPanel is tracked so destroy() can tear it down.
    let wofSignPanel = null;
    {
        const wofDate = d.date || new Date().toISOString().slice(0, 10);   // today (the signable wall)
        const _WOF_EPOCH = '2026-04-22';
        let _wofView = wofDate;                                             // date currently being viewed
        const wofTablet = { loading: true, error: null, leaderboard: { entries: [] }, scrollOffset: 0 };
        const ARROW_HIT = { up: { nx: 0.5, ny: 156/180, hw: 24/256, hh: 8/180 }, down: { nx: 0.5, ny: 172/180, hw: 24/256, hh: 8/180 } };
        const DATE_HIT = { prev: { nx: 0.11, ny: 0.135, hw: 0.08, hh: 0.06 }, next: { nx: 0.89, ny: 0.135, hw: 0.08, hh: 0.06 } };
        const isComplete = !!d.is_complete;
        let signed = false;
        try { signed = localStorage.getItem('ds_signed_' + wofDate) === 'true'; } catch (e) {}
        const viewingToday = () => _wofView === wofDate;
        const canSign = () => isComplete && viewingToday() && !signed;
        const _wofAddDays = (ds, n) => { const dd = new Date(ds + 'T00:00:00Z'); dd.setUTCDate(dd.getUTCDate() + n); return dd.toISOString().slice(0, 10); };

        function drawTablet(ctx, w, h, tState) {
            ctx.fillStyle = '#2a2520'; ctx.fillRect(0, 0, w, h);
            const sd = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < sd.data.length; i += 4) { const n = (Math.random() * 12 - 6) | 0; sd.data[i] += n; sd.data[i+1] += n; sd.data[i+2] += n; }
            ctx.putImageData(sd, 0, 0);
            ctx.strokeStyle = '#6a5440'; ctx.lineWidth = Math.max(4, h * 0.018); ctx.strokeRect(10, 10, w - 20, h - 20);
            ctx.font = `bold ${Math.round(h * 0.075)}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#e8c040';
            ctx.fillText('WALL OF FAME', w / 2, h * 0.04);
            // Date-history nav: ‹ date › to browse past walls.
            ctx.textBaseline = 'middle';
            const canPrev = _wofView > _WOF_EPOCH, canNext = _wofView < wofDate;
            ctx.font = `bold ${Math.round(h * 0.07)}px monospace`;
            ctx.fillStyle = canPrev ? '#caa86a' : '#463c28'; ctx.fillText('‹', w * 0.11, h * 0.135);
            ctx.fillStyle = canNext ? '#caa86a' : '#463c28'; ctx.fillText('›', w * 0.89, h * 0.135);
            ctx.font = `bold ${Math.round(h * 0.05)}px monospace`; ctx.fillStyle = '#d8c89a';
            ctx.fillText(_wofView + (viewingToday() ? '  • TODAY' : ''), w / 2, h * 0.135);
            ctx.textBaseline = 'top';
            ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(w * 0.06, h * 0.2); ctx.lineTo(w * 0.94, h * 0.2); ctx.stroke();
            const big = (t, c) => { ctx.font = `bold ${Math.round(h * 0.06)}px monospace`; ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, w / 2, h * 0.48); };
            const lb = tState.leaderboard; const entries = (lb && lb.entries) || [];
            const rIcon = { '-1': '👎', '1': '👍', '2': '🔥' };
            if (tState.loading) { big('Carving names…', '#9a8a6a'); }
            else if (tState.error) { big(tState.error, '#c66'); }
            else if (entries.length === 0) { big('No names carved yet', '#888'); }
            else {
                const scrollOff = tState.scrollOffset || 0;
                const start = h * 0.235, rowH = h * 0.068, pad = w * 0.07;
                ctx.textBaseline = 'middle';
                for (let i = 0; i < 8; i++) {
                    const idx = scrollOff + i; if (idx >= entries.length) break; const e = entries[idx]; const ey = start + i * rowH + rowH / 2;
                    ctx.font = `bold ${Math.round(h * 0.046)}px monospace`; ctx.fillStyle = '#8a7458'; ctx.textAlign = 'right'; ctx.fillText(String(idx + 1) + '.', pad + w * 0.05, ey);
                    ctx.textAlign = 'left'; ctx.font = `${Math.round(h * 0.05)}px monospace`; ctx.fillStyle = '#efe6d8'; ctx.fillText((e.display_name || 'Unknown').substring(0, 16), pad + w * 0.08, ey);
                    if (e.streak && e.streak > 1) { ctx.textAlign = 'right'; ctx.fillStyle = '#d49050'; ctx.font = `${Math.round(h * 0.04)}px monospace`; ctx.fillText('🔥' + e.streak + 'd', w * 0.83, ey); }
                    if (e.rating != null && rIcon[e.rating]) { ctx.textAlign = 'right'; ctx.font = `${Math.round(h * 0.05)}px serif`; ctx.fillText(rIcon[e.rating], w * 0.93, ey); }
                }
                const maxOff = Math.max(0, entries.length - 8);
                if (entries.length > 8) {
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold ${Math.round(h * 0.06)}px monospace`;
                    const au = ARROW_HIT.up, ad = ARROW_HIT.down;
                    ctx.fillStyle = scrollOff > 0 ? '#e8c040' : '#3a3020'; ctx.fillText('▲', w * au.nx, h * au.ny);
                    ctx.fillStyle = scrollOff < maxOff ? '#e8c040' : '#3a3020'; ctx.fillText('▼', w * ad.nx, h * ad.ny);
                }
            }
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = `bold ${Math.round(h * 0.048)}px monospace`;
            const sy = h - h * 0.03;
            if (!viewingToday()) { ctx.fillStyle = '#7a6a48'; ctx.fillText('‹ › BROWSE PAST WALLS', w / 2, sy); }
            else if (signed) { ctx.fillStyle = '#6a9a6a'; ctx.fillText('✓ SIGNED', w / 2, sy); }
            else if (isComplete) { ctx.fillStyle = '#e8c040'; ctx.fillText('CLICK TO SIGN', w / 2, sy); }
            else { ctx.fillStyle = '#6a5a3a'; ctx.fillText('FINISH TODAY TO SIGN', w / 2, sy); }
        }

        const tabletSurface = _dsCreateDiegeticSurface(THREE, {
            scene, raycasterObjects,
            position: [HW / 2 - 0.05, 0.5, -2.5], rotation: [0, -Math.PI / 2, 0], size: [2.8, 2.2],
            resolution: [512, 360], linearFilter: true,
            draw: (ctx, w, h) => drawTablet(ctx, w, h, wofTablet),
        });
        let _wofReq = 0;
        function refetchLeaderboard() {
            const req = ++_wofReq;
            fetch('/api/plugins/the_daily/leaderboard?date=' + encodeURIComponent(_wofView), { cache: 'no-store' })
                .then((r) => r.text())
                .then((text) => { if (destroyed || req !== _wofReq) return; wofTablet.leaderboard = text ? JSON.parse(text) : { entries: [] }; wofTablet.loading = false; wofTablet.error = null; tabletSurface.refresh(); })
                .catch(() => { if (destroyed || req !== _wofReq) return; wofTablet.loading = false; wofTablet.error = 'Supabase unreachable'; tabletSurface.refresh(); });
        }
        function wofChangeDate(dir) {
            const nx = _wofAddDays(_wofView, dir);
            if (nx < _WOF_EPOCH || nx > wofDate) return;
            _wofView = nx; wofTablet.scrollOffset = 0; wofTablet.loading = true; wofTablet.error = null; tabletSurface.refresh(); refetchLeaderboard();
        }
        refetchLeaderboard();

        function openSignPanel() {
            if (wofSignPanel || !canSign()) return;
            if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
            let rating = null;
            const p = document.createElement('div');
            p.style.cssText = 'position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
            p.innerHTML = `
                <div style="background:#1a1510;border:2px solid #5a4a3a;border-radius:6px;padding:20px;width:min(320px,86vw);font-family:monospace;text-align:center;">
                    <div style="color:#e8c040;letter-spacing:.18em;font-weight:700;margin-bottom:14px;">SIGN THE WALL</div>
                    <input id="ds-wof-name" type="text" maxlength="30" placeholder="Your name" style="width:100%;box-sizing:border-box;background:#0d0a06;border:1px solid #5a4a3a;border-radius:3px;color:#eee;font:12px monospace;padding:7px;margin-bottom:8px;outline:none;">
                    <input id="ds-wof-msg" type="text" maxlength="60" placeholder="Comment (optional)" style="width:100%;box-sizing:border-box;background:#0d0a06;border:1px solid #5a4a3a;border-radius:3px;color:#ccc;font:11px monospace;padding:7px;margin-bottom:10px;outline:none;">
                    <div id="ds-wof-rate" style="display:flex;justify-content:center;gap:10px;margin-bottom:12px;">
                        <button data-r="-1" style="font-size:1.3rem;background:none;border:1px solid #444;border-radius:4px;padding:4px 10px;cursor:pointer;">👎</button>
                        <button data-r="1" style="font-size:1.3rem;background:none;border:1px solid #444;border-radius:4px;padding:4px 10px;cursor:pointer;">👍</button>
                        <button data-r="2" style="font-size:1.3rem;background:none;border:1px solid #444;border-radius:4px;padding:4px 10px;cursor:pointer;">🔥</button>
                    </div>
                    <div id="ds-wof-err" style="color:#e0706a;font-size:.7rem;min-height:14px;margin-bottom:8px;"></div>
                    <div style="display:flex;gap:8px;">
                        <button id="ds-wof-submit" style="flex:1;background:#3a2f12;border:1px solid #6a5a2a;border-radius:4px;color:#ffd24a;font:bold 12px monospace;letter-spacing:.1em;padding:9px;cursor:pointer;">SIGN</button>
                        <button id="ds-wof-cancel" style="background:none;border:1px solid #444;border-radius:4px;color:#888;font:12px monospace;padding:9px 14px;cursor:pointer;">CANCEL</button>
                    </div>
                </div>`;
            canvasWrap.appendChild(p);
            wofSignPanel = p;
            const close = () => { if (p.parentNode) p.parentNode.removeChild(p); if (wofSignPanel === p) wofSignPanel = null; };
            p.querySelectorAll('#ds-wof-rate button').forEach((b) => b.addEventListener('click', () => {
                rating = parseInt(b.dataset.r, 10);
                p.querySelectorAll('#ds-wof-rate button').forEach((x) => x.style.borderColor = '#444');
                b.style.borderColor = '#e8c040';
            }));
            p.querySelector('#ds-wof-cancel').addEventListener('click', close);
            ['ds-wof-name', 'ds-wof-msg'].forEach((id) => p.querySelector('#' + id).addEventListener('keydown', (e) => e.stopPropagation()));
            const submit = p.querySelector('#ds-wof-submit');
            submit.addEventListener('click', () => {
                const name = (p.querySelector('#ds-wof-name').value || '').trim();
                const errEl = p.querySelector('#ds-wof-err');
                if (!name) { errEl.textContent = 'Enter your name'; return; }
                submit.disabled = true; submit.textContent = 'SIGNING…';
                const msg = (p.querySelector('#ds-wof-msg').value || '').trim();
                const payload = { display_name: name, rating, install_id: dsInstallId() };
                if (msg) payload.message = msg;
                fetch('/api/plugins/the_daily/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
                    .then((r) => r.text())
                    .then((text) => {
                        const data = text ? JSON.parse(text) : {};
                        if (data.error) { errEl.textContent = data.error; submit.disabled = false; submit.textContent = 'SIGN'; return; }
                        signed = true; try { localStorage.setItem('ds_signed_' + wofDate, 'true'); } catch (e) {}
                        close(); refetchLeaderboard(); tabletSurface.refresh();
                    })
                    .catch(() => { errEl.textContent = 'Network error'; submit.disabled = false; submit.textContent = 'SIGN'; });
            });
            setTimeout(() => { const ni = p.querySelector('#ds-wof-name'); if (ni) ni.focus(); }, 50);
        }

        hubSections.push({
            interact: (rc) => {
                for (const hit of rc.intersectObjects([tabletSurface.mesh])) {
                    if (hit.object === tabletSurface.mesh && hit.uv) {
                        const ux = hit.uv.x, uy = 1 - hit.uv.y;
                        const dp = DATE_HIT.prev, dn = DATE_HIT.next;
                        if (ux >= dp.nx - dp.hw && ux <= dp.nx + dp.hw && uy >= dp.ny - dp.hh && uy <= dp.ny + dp.hh) { wofChangeDate(-1); return true; }
                        if (ux >= dn.nx - dn.hw && ux <= dn.nx + dn.hw && uy >= dn.ny - dn.hh && uy <= dn.ny + dn.hh) { wofChangeDate(1); return true; }
                        const entries = (wofTablet.leaderboard && wofTablet.leaderboard.entries) || [];
                        const maxOff = Math.max(0, entries.length - 8);
                        const au = ARROW_HIT.up, ad = ARROW_HIT.down;
                        if (wofTablet.scrollOffset > 0 && ux >= au.nx - au.hw && ux <= au.nx + au.hw && uy >= au.ny - au.hh && uy <= au.ny + au.hh) { wofTablet.scrollOffset--; tabletSurface.refresh(); return true; }
                        if (wofTablet.scrollOffset < maxOff && ux >= ad.nx - ad.hw && ux <= ad.nx + ad.hw && uy >= ad.ny - ad.hh && uy <= ad.ny + ad.hh) { wofTablet.scrollOffset++; tabletSurface.refresh(); return true; }
                        if (canSign()) openSignPanel();
                        return true;
                    }
                }
                return false;
            },
            dispose: () => { tabletSurface.dispose(); if (wofSignPanel && wofSignPanel.parentNode) wofSignPanel.parentNode.removeChild(wofSignPanel); wofSignPanel = null; },
        });
    }

    // Creative "vault antechamber" dressing — pillars, beams, ritual dais,
    // braziers, the animated descent rift, banners, and drifting embers.
    const hubDressing = _dsDressHub(THREE, scene, { HW, HH, HL, HY, doorZ });

    // ── Quake first-person controls (unifies the Hub with the dungeon, ADR 0010) ─
    // The Hub used to be a rail: forward = straight into Today. Now you mouselook +
    // WASD around the chamber and enter an area by walking into its Passage.
    const qc = _dsQuakeController(camera, { eye: HY });
    let pointerLocked = false;
    const HX_LIMIT = HW / 2 - 0.5, HZ_BACK = 1.0, HZ_FAR = doorZ, PASS_HALF = 0.85;
    let lastThud = 0;
    const passageEntries = [
        { id: 'today', x: 0 },
    ];

    // The diegetic exit door was removed — leaving the Daily is now via Esc
    // (showExitConfirm → exitToHost) or the main-menu QUIT, not an in-world door.

    // Modifier plaque — stone-styled diegetic surface next to the Today Passage
    const plaqueSurface = _dsCreateDiegeticSurface(THREE, {
        scene,
        position: [1.1, 0.8, doorZ + 0.03],
        rotation: [0, 0, 0],
        size: [0.65, 0.45],
        raycasterObjects,
        draw: (ctx, w, h) => {
            const mod = d.modifier || {};
            const icon   = mod.icon || '';
            const label  = (mod.label || '').toUpperCase();
            const desc   = mod.description || '';

            // Stone background with noise grain
            ctx.fillStyle = '#2a2520';
            ctx.fillRect(0, 0, w, h);
            const sd = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < sd.data.length; i += 4) {
                const n = Math.floor(Math.random() * 12 - 6);
                sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
                sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
                sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
            }
            ctx.putImageData(sd, 0, 0);

            // Outer bevel
            ctx.strokeStyle = '#5a4a3a';
            ctx.lineWidth = 4;
            ctx.strokeRect(8, 8, w - 16, h - 16);
            ctx.strokeStyle = '#1a1510';
            ctx.lineWidth = 2;
            ctx.strokeRect(14, 14, w - 28, h - 28);

            // Icon
            ctx.font = '30px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#d4a044';
            ctx.fillText(icon, w / 2, 22);

            // Label
            ctx.font = 'bold 11px monospace';
            ctx.fillStyle = '#e8c040';
            if (label) ctx.fillText(label, w / 2, 58);

            // Description — word-wrapped
            ctx.font = '9px monospace';
            ctx.fillStyle = '#a09080';
            const maxW = w - 32;
            const words = desc.split(' ');
            let line = '';
            let ly = 78;
            for (const word of words) {
                const test = line + (line ? ' ' : '') + word;
                if (ctx.measureText(test).width > maxW && line) {
                    ctx.fillText(line, w / 2, ly);
                    line = word;
                    ly += 12;
                } else {
                    line = test;
                }
            }
            if (line) ctx.fillText(line, w / 2, ly);
        },
    });

    // HTML layers
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    overlay.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;transition:opacity 0.3s;';
    canvasWrap.appendChild(fadeEl);

    const escHint = document.createElement('div');
    escHint.style.cssText = 'position:absolute;bottom:8px;left:8px;z-index:3;color:#444;font-family:monospace;font-size:0.65rem;letter-spacing:.12em;pointer-events:none;';
    escHint.textContent = 'ESC — LEAVE';
    canvasWrap.appendChild(escHint);

    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '▲';
    btnFwd.style.cssText = 'position:absolute;bottom:8px;right:8px;width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    // Touch / no-mouse fallback: hold to walk forward (toward whatever you face).
    const _fwdHold = (v) => (ev) => { ev.preventDefault(); if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') qc.keys.f = v; };
    btnFwd.addEventListener('pointerdown', _fwdHold(true));
    btnFwd.addEventListener('pointerup', _fwdHold(false));
    btnFwd.addEventListener('pointerleave', _fwdHold(false));
    btnFwd.addEventListener('pointercancel', _fwdHold(false));
    canvasWrap.appendChild(btnFwd);

    // Turn buttons (touch) — to the left of the forward button.
    const btnTurnL = document.createElement('button');
    btnTurnL.innerHTML = '◀';
    btnTurnL.style.cssText = 'position:absolute;bottom:8px;right:160px;width:44px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#777;font-family:monospace;font-size:1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    btnTurnL.onclick = () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') qc.yaw += 0.35; };
    canvasWrap.appendChild(btnTurnL);
    const btnTurnR = document.createElement('button');
    btnTurnR.innerHTML = '▶';
    btnTurnR.style.cssText = 'position:absolute;bottom:8px;right:110px;width:44px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#777;font-family:monospace;font-size:1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;z-index:6;';
    btnTurnR.onclick = () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') qc.yaw -= 0.35; };
    canvasWrap.appendChild(btnTurnR);

    // One-time controls hint (mouselook needs a click to engage Pointer Lock).
    const hubHintEl = document.createElement('div');
    hubHintEl.textContent = 'CLICK TO LOOK · WASD MOVE · CLICK A STATION · WALK INTO TODAY TO DESCEND';
    hubHintEl.style.cssText = 'position:absolute;bottom:64px;left:50%;transform:translateX(-50%);color:#7a7a7a;font-family:monospace;font-size:0.7rem;letter-spacing:.16em;z-index:4;pointer-events:none;text-shadow:0 0 6px #000;transition:opacity .4s ease;';
    canvasWrap.appendChild(hubHintEl);
    function hideHubHint() { if (hubHintEl) hubHintEl.style.opacity = '0'; }

    const hubReticle = document.createElement('div');
    hubReticle.className = 'ds-reticle';
    canvasWrap.appendChild(hubReticle);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;flex-shrink:0;';
    const mod = d.modifier || {};
    hudEl.innerHTML = `<span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.day_name || '')}</span><span style="color:#444;">${esc(mod.label || '')}</span>`;
    overlay.appendChild(hudEl);

    const lookTarget    = new THREE.Vector3(0, HY, doorZ);
    const curLookTarget = new THREE.Vector3(0, HY, doorZ);
    const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    let prevTime = performance.now();
    let destroyed = false;

    function loop(now) {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        const dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        // Authentic Quake 10 Hz lightstyle flicker on the wall torches (the
        // accent/portal glows below stay smooth — magical auras, not fire).
        torch1.intensity = 2.0 * (0.7 + _dsSampleLightstyle('fire', now, 0) * 0.34);
        torch2.intensity = 1.6 * (0.7 + _dsSampleLightstyle('fire', now, 7.3) * 0.34);
        passageGlow.intensity = 2.0 + Math.sin(now * 0.003) * 0.5;
        archiveGlow.intensity = 1.5 + Math.sin(now * 0.003 + 1.0) * 0.4;
        passportGlow.intensity = 1.5 + Math.sin(now * 0.003 + 2.0) * 0.4;
        shopGlow.intensity = 1.5 + Math.sin(now * 0.003 + 3.0) * 0.4;
        wofGlow.intensity = 1.5 + Math.sin(now * 0.003 + 4.0) * 0.4;
        if (hubDressing) hubDressing.tick(now, dt);

        if (state.phase === 'moving') {
            state.moveTween = Math.min(state.moveTween + dt / 2.5, 1);
            const t = easeInOutCubic(state.moveTween);
            camera.position.z = state.moveStartZ + (doorZ - state.moveStartZ) * t;
            if (typeof state.moveStartX !== 'undefined' && typeof state.passageX !== 'undefined') {
                camera.position.x = state.moveStartX + (state.passageX - state.moveStartX) * t;
            }
            camera.position.y = HY + Math.sin(t * Math.PI * 4) * 0.022;
            // Footstep scheduling — three steps across the passage walk
            var stepIdx = Math.floor(state.moveTween * 3);
            if (stepIdx > (state._lastStep || -1)) {
                state._lastStep = stepIdx;
                if (_dsAudio) _dsAudio.playFootstep(0.4 + (stepIdx / 3) * 0.3);
            }
            if (state.moveTween >= 1) {
                if (_dsAudio) _dsAudio.playDoorOpen();
                state.phase = 'transitioning';
                fadeEl.style.opacity = '1';
                setTimeout(() => {
                    if (!destroyed) {
                        destroy();
                        _dsHub = null;
                        if (state.targetPassageId === 'today') {
                            _dsStartRun(overlay, d);
                        } else {
                            // Exit door: leave the Daily entirely (no 2D fallback).
                            dsDungeonExit();
                            try { window.showScreen('home'); } catch (e) {}
                        }
                    }
                }, 300);
            }
        } else if (state.phase === 'idle') {
            qc.applyLook();      // consume Pointer-Lock mouse deltas
            hubMoveStep(dt);     // Quake walk + chamber/passage collision
        }

        if (state.phase === 'idle') {
            camera.rotation.set(qc.pitch, qc.yaw, qc.viewRoll);
        } else {
            // Walk-through transition: turn toward the chosen Passage as we glide in.
            curLookTarget.lerp(lookTarget, Math.min(1, dt * 8));
            camera.lookAt(curLookTarget);
        }
        renderer.render(scene, camera);
    }

    // One Quake ground-move step against the Hub chamber. Walking into a Passage
    // opening on the back wall enters that area (sealed ones thud + block).
    function hubMoveStep(dt) {
        const w = qc.wishDir();
        qc.accelerate(dt, w.wx, w.wz, w.wishspeed);
        // The Quake controller works in Quake-scale velocity (maxspeed ~320); the
        // dungeon matches it by scaling its world ×64. The Hub is unscaled small
        // units, so the velocity/bob output is divided by the same factor to get
        // the same walking feel in this chamber.
        const MS = 1 / 64;
        let nx = camera.position.x + qc.vel.x * dt * MS;
        let nz = camera.position.z + qc.vel.z * dt * MS;
        if (nz <= HZ_FAR + 0.55) {
            let entered = null;
            for (const pe of passageEntries) {
                if (Math.abs(nx - pe.x) <= PASS_HALF) { entered = pe; break; }
            }
            if (entered) {
                if (_dsIsPassageOpen(entered.id)) { moveToPassage(entered.id); return; }
                const tnow = performance.now();
                if (tnow - lastThud > 700) { _dsPlayThud(); lastThud = tnow; }
            }
            nz = HZ_FAR + 0.55; qc.vel.z = 0;
        }
        if (nz > HZ_BACK) { nz = HZ_BACK; qc.vel.z = 0; }
        if (nx < -HX_LIMIT) { nx = -HX_LIMIT; qc.vel.x = 0; }
        if (nx >  HX_LIMIT) { nx =  HX_LIMIT; qc.vel.x = 0; }
        camera.position.x = nx;
        camera.position.z = nz;
        camera.position.y = HY + qc.viewBobRoll(dt) * MS;
    }

    function moveToPassage(passageId) {
        if (state.phase !== 'idle') return;
        if (passageId === 'exit') { exitToHost(); return; }
        const p = passages[passageId];
        if (!p) return;
        if (!_dsIsPassageOpen(passageId)) {
            _dsPlayThud();
            return;
        }
        if (pointerLocked && document.exitPointerLock) document.exitPointerLock();
        // Seed the turn-tween from where the player is currently looking so the
        // glide into the Passage starts from their gaze, not a hard snap.
        const dir = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
        curLookTarget.copy(camera.position).add(dir);
        lookTarget.set(p.x, HY, doorZ);
        state.moveStartZ = camera.position.z;
        state.moveStartX = camera.position.x;
        state.phase = 'moving';
        state.moveTween = 0;
        state.targetPassageId = passageId;
        state.passageX = p.x;
    }

    function _dsIsPassageOpen(passageId) {
        const p = passages[passageId];
        if (!p) return false;
        if (passageId === 'today') return true;
        return false;
    }

    function exitToHost() {
        if (state.phase !== 'idle') return;
        destroy();
        _dsHub = null;
        dsDungeonExit();
        // Hide all plugin 2D views so host chrome shows through cleanly
        ['loading', 'setlist', 'complete', 'leaderboard', 'passport', 'shop'].forEach(v => {
            const el = document.getElementById(`ds-${v}`);
            if (el) el.classList.add('hidden');
        });
        _dsInitialized = false;
        // Navigate host back to its default screen (e.g. 'app')
        if (window._dsOrigShowScreen) {
            try { window._dsOrigShowScreen('app'); } catch (_e) { /* host may not have an 'app' screen */ }
        }
    }

    function showExitConfirm() {
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        _dsRenderMenu(overlay, {
            title: 'LEAVE THE DAILY?',
            subtitle: 'Exit to the Slopsmith homepage.',
            items: [
                { label: 'YES, EXIT', action: () => {
                    _dsCloseMenu();
                    _dsHubEscConfirmed = true;
                    exitToHost();
                }},
                { label: 'CANCEL', action: _dsCloseMenu },
            ],
            onCancel: _dsCloseMenu,
        });
    }

    const onKey = (e) => {
        if (state.phase === 'transitioning' || destroyed) return;
        if (_dsAudio) _dsAudio.init();
        if (e.key === 'Escape') {
            if (pointerLocked && document.exitPointerLock) document.exitPointerLock();
            if (_dsHubEscConfirmed) { exitToHost(); } else { showExitConfirm(); }
            e.preventDefault(); return;
        }
        if (state.phase === 'idle' && qc.setMoveKey(e, true)) { hideHubHint(); e.preventDefault(); }
    };
    const onKeyUp = (e) => { if (qc.setMoveKey(e, false)) e.preventDefault(); };
    const onMouseMove = (e) => { if (pointerLocked && state.phase === 'idle') qc.addMouse(e.movementX, e.movementY); };
    const onPointerLockChange = () => { pointerLocked = (document.pointerLockElement === canvas); if (pointerLocked) { hideHubHint(); hubReticle.classList.add('ds-reticle-on'); } else { hubReticle.classList.remove('ds-reticle-on'); } };
    const onBlur = () => qc.clearKeys();
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('blur', onBlur);
    canvas.addEventListener('click', (e) => {
        if (_dsAudio) _dsAudio.init();
        if (state.phase !== 'idle') return;
        // Raycast against in-hub section surfaces (crosshair when locked, else
        // cursor). If a station handled the click, stay as-is; otherwise grab
        // pointer lock so mouselook resumes.
        if (pointerLocked) mouse.set(0, 0);
        else {
            const rect = canvas.getBoundingClientRect();
            mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        }
        raycaster.setFromCamera(mouse, camera);
        for (const s of hubSections) { if (s.interact(raycaster)) return; }
        if (!pointerLocked && canvas.requestPointerLock) canvas.requestPointerLock();
    });

    const disposables = [wallMat, floorMat, ceilMat, backMat, darkWallMat];
    function start() {
        curLookTarget.copy(lookTarget);
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);
    }

    function refresh() {
        plaqueSurface.refresh();
    }

    function setPassageSealed(passageId, sealed) {
        const p = passages[passageId];
        if (p) p.setSealed(sealed);
    }

    // ── Boss-complete celebration (beat 1 in Hub) ────────────────────────────
    const hubBossEffects = [];
    let hubBossSlab = null;
    let celebrationDone = false;

    function triggerBossCelebration(streak) {
        if (celebrationDone) return;
        celebrationDone = true;
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        // Boss-clear stinger — Doom-style power chord
        if (_dsAudio) _dsAudio.playBossClear();
        // Celebration full-screen overlay
        const celEl = document.createElement('div');
        celEl.id = 'ds-boss-celebration';
        celEl.style.cssText = 'position:absolute;inset:0;z-index:10;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace;';
        celEl.innerHTML = `
            <div style="font-size:3rem;margin-bottom:12px;">👑</div>
            <div style="font-size:1.6rem;color:#f87171;letter-spacing:.2em;margin-bottom:20px;">FINISHED</div>
            <div style="border:2px solid #5a4a3a;background:#1a1510;padding:24px 40px;margin-bottom:20px;text-align:center;">
                <div style="color:#8a7a6a;font-size:3.5rem;font-family:serif;margin-bottom:4px;">${streak > 1 ? String(streak) : ''}</div>
                <div style="color:#6a5a4a;font-size:0.75rem;letter-spacing:.15em;">${streak > 1 ? 'DAY STREAK' : 'DAILY COMPLETE'}</div>
            </div>
            <button id="ds-cel-dismiss" style="background:none;border:1px solid #444;color:#888;padding:8px 24px;cursor:pointer;font-family:monospace;font-size:0.75rem;letter-spacing:.15em;border-radius:4px;">CONTINUE</button>
        `;
        canvasWrap.appendChild(celEl);

        // 3D effects — flare, torches, diegetic slab
        const hFlare = new THREE.PointLight(0x991b1b, 0, 12);
        hFlare.position.set(0, 0.5, doorZ);
        scene.add(hFlare);
        hubBossEffects.push(hFlare);
        const fStart = performance.now();
        function hFlareAnim(now) {
            const t = (now - fStart) / 1000;
            if (t < 2) { hFlare.intensity = (t / 2) * 5; requestAnimationFrame(hFlareAnim); }
            else if (t < 3) { hFlare.intensity = 5 - ((t - 2) / 1) * 3; requestAnimationFrame(hFlareAnim); }
            else { hFlare.intensity = 2; }
        }
        requestAnimationFrame(hFlareAnim);

        const hT3 = new THREE.PointLight(0xff6622, 2.5, 8);
        hT3.position.set(-2.5, 1.2, doorZ - 1);
        scene.add(hT3);
        hubBossEffects.push(hT3);
        const hT4 = new THREE.PointLight(0xff6622, 2.5, 8);
        hT4.position.set(2.5, 1.2, doorZ - 1);
        scene.add(hT4);
        hubBossEffects.push(hT4);

        if (streak > 1) {
            hubBossSlab = _dsCreateDiegeticSurface(THREE, {
                scene,
                position: [0, 0.3, doorZ + 0.4],
                rotation: [0, 0, 0],
                size: [0.6, 0.4],
                draw: (ctx, w, h) => {
                    ctx.fillStyle = '#2a2520';
                    ctx.fillRect(0, 0, w, h);
                    const sd = ctx.getImageData(0, 0, w, h);
                    for (let i = 0; i < sd.data.length; i += 4) {
                        const n = Math.floor(Math.random() * 12 - 6);
                        sd.data[i]   = Math.min(255, Math.max(0, sd.data[i]   + n));
                        sd.data[i+1] = Math.min(255, Math.max(0, sd.data[i+1] + n));
                        sd.data[i+2] = Math.min(255, Math.max(0, sd.data[i+2] + n));
                    }
                    ctx.putImageData(sd, 0, 0);
                    ctx.strokeStyle = '#5a4a3a';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(6, 6, w - 12, h - 12);
                    ctx.font = 'bold 48px serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = '#8a7a6a';
                    ctx.fillText(String(streak), w / 2, h / 2 - 6);
                    ctx.font = 'bold 12px monospace';
                    ctx.fillStyle = '#6a5a4a';
                    ctx.fillText('DAY STREAK', w / 2, h / 2 + 28);
                },
            });
        }

        // Dismiss handler — removes the overlay and (beat 2) takes the player
        // straight into the Wall of Fame to sign, rather than just unsealing the
        // door and leaving them in the lobby to find it.
        const dismissBtn = celEl.querySelector('#ds-cel-dismiss');
        function dismissCel() {
            // The Wall of Fame is now an in-hub station — dismiss the celebration
            // and leave the player in the Hub, where they can walk to the WoF
            // tablet to sign.
            if (celEl.parentNode) celEl.parentNode.removeChild(celEl);
            wofUnsealPending = false;
        }
        if (dismissBtn) dismissBtn.onclick = dismissCel;
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKeyUp);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('pointerlockchange', onPointerLockChange);
        window.removeEventListener('blur', onBlur);
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        if (hubReticle.parentNode) hubReticle.parentNode.removeChild(hubReticle);
        // Clean up celebration overlay
        const celEl = document.getElementById('ds-boss-celebration');
        if (celEl && celEl.parentNode) celEl.parentNode.removeChild(celEl);
        // Clean up boss effects
        hubBossEffects.forEach(l => { scene.remove(l); });
        hubBossEffects.length = 0;
        if (hubBossSlab) { hubBossSlab.dispose(); hubBossSlab = null; }
        Object.values(passages).forEach(p => p.dispose());
        hubSections.forEach(s => { try { s.dispose(); } catch (e) {} });
        if (hubDressing) hubDressing.dispose();
        // Clean up exit door
        disposables.forEach(m => { try { m.dispose(); } catch(e) {} });
        plaqueSurface.dispose();
        renderer.dispose();
    }

    // Texture every remaining solid surface (stations, doors, beams, props…).
    _dsTextureAllSurfaces(THREE, scene);

    return { start, destroy, refresh, setPassageSealed, triggerBossCelebration };
}

// ── Wall of Fame Room (stone hall behind unsealed WoF Passage) ────────────
function _dsWebGLAvailable() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext &&
            (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) {
        return false;
    }
}

// Pure-DOM fatal overlay (no WebGL) with a guaranteed escape hatch. Used when
// the 3D scene can't be built. Without this the ESC handler — which lives
// inside the hub/dungeon scene that failed to build — never registers, trapping
// the user on a black full-screen takeover.
function _dsShowDungeonFatal(overlay, title, body) {
    overlay.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.25rem;font-family:monospace;text-align:center;padding:2rem;';
    wrap.innerHTML =
        '<div style="font-size:2.5rem;">🎸</div>' +
        '<div style="font-size:1.1rem;letter-spacing:.18em;color:#f87171;text-transform:uppercase;">' + title + '</div>' +
        '<div style="max-width:34rem;font-size:.85rem;line-height:1.6;color:#94a3b8;">' + body + '</div>';
    const btn = document.createElement('button');
    btn.textContent = 'EXIT';
    btn.style.cssText = 'margin-top:.5rem;padding:.6rem 2rem;border:1px solid #475569;background:#1e293b;color:#e2e8f0;font-family:monospace;letter-spacing:.2em;cursor:pointer;border-radius:.5rem;';
    btn.onmouseenter = () => { btn.style.borderColor = '#94a3b8'; };
    btn.onmouseleave = () => { btn.style.borderColor = '#475569'; };
    const bail = () => {
        window.removeEventListener('keydown', onKey, true);
        try { dsDungeonExit(); } catch (e) {}
        try { window.showScreen('home'); } catch (e) {}
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); bail(); } };
    btn.onclick = bail;
    wrap.appendChild(btn);
    overlay.appendChild(wrap);
    window.addEventListener('keydown', onKey, true);
}

async function dsDungeonEnter(d) {
    let overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ds-dungeon-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;';
    overlay.style.display = 'flex';

    if (!_dsTHREE) {
        overlay.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#60a5fa;font-family:monospace;font-size:1.1rem;letter-spacing:.2em;">ENTERING HUB...</div>';
        try {
            _dsTHREE = await import('https://cdn.jsdelivr.net/npm/three@0.167.0/build/three.module.min.js');
        } catch (e) {
            _dsShowDungeonFatal(overlay, 'Connection required',
                "The Daily couldn't load its 3D engine. Check your internet connection and try again.");
            return;
        }
    }

    if (!_dsWebGLAvailable()) {
        _dsShowDungeonFatal(overlay, 'Graphics unavailable',
            "The Daily's dungeon needs WebGL, which your browser or device isn't providing right now. Enable hardware acceleration or try another browser to play today's run.");
        return;
    }

    // Tear down any existing hub, dungeon, WoF Room, archive, or hall before entering the Hub.
    if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
    if (_dsWofRoom) { _dsWofRoom.destroy(); _dsWofRoom = null; }
    if (_dsArchiveRoom) { _dsArchiveRoom.destroy(); _dsArchiveRoom = null; }
    if (_dsHallOfRecords) { _dsHallOfRecords.destroy(); _dsHallOfRecords = null; }
    if (_dsShopRoom) { _dsShopRoom.destroy(); _dsShopRoom = null; }
    if (_dsHub) { _dsHub.destroy(); _dsHub = null; }
    overlay.innerHTML = '';
    // Init shared audio if not already running. Ambient drone cross-fades
    // through the main menu, Hub, and dungeon without restart between rooms.
    if (_dsAudio) _dsAudio.init();
    if (_dsAudio) _dsAudio.setRoomMotif('hub');
    // The Quake-1 main menu is the front door; its DESCEND/CONTINUE option
    // walks the player into the Hub (the 3D lobby).
    _dsShowMainMenu(overlay, d);
}

function dsDungeonExit() {
    _dsCloseMenu();
    if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
    if (_dsWofRoom) { _dsWofRoom.destroy(); _dsWofRoom = null; }
    if (_dsArchiveRoom) { _dsArchiveRoom.destroy(); _dsArchiveRoom = null; }
    if (_dsHallOfRecords) { _dsHallOfRecords.destroy(); _dsHallOfRecords = null; }
    if (_dsShopRoom) { _dsShopRoom.destroy(); _dsShopRoom = null; }
    if (_dsErrorScene) { _dsErrorScene.destroy(); _dsErrorScene = null; }
    if (_dsAudio) _dsAudio.stop();
    const overlay = document.getElementById('ds-dungeon-overlay');
    if (overlay) overlay.style.display = 'none';
}

// Re-enter the dungeon scene after returning from a song. dsPlayMapNode tears
// the dungeon down (dsDungeonExit) before handing off to playSong, so on return
// we rebuild it directly — landing the player back in the room they just cleared
// (the dungeon's start() reads the saved node + _dsRoomJustCleared to play the
// unseal beat). This re-enters the *dungeon*, not the Hub.
async function dsResumeDungeon() {
    if (!_dsTHREE) { await dsDungeonEnter(_dsData); return; }
    let overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ds-dungeon-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;';
    overlay.style.display = 'flex';
    if (_dsAudio) _dsAudio.init();
    _dsStartRun(overlay, _dsData);
}

// On daily completion: enter the Hub and play the boss celebration in place.
// The Wall of Fame is now an in-hub station, so the player signs by walking to
// the WoF tablet — no separate signing room.
async function dsEnterWof(d, opts) {
    let overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ds-dungeon-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;';
    overlay.style.display = 'flex';
    if (!_dsTHREE) {
        overlay.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#60a5fa;font-family:monospace;font-size:1.1rem;letter-spacing:.2em;">LOADING...</div>';
        try { _dsTHREE = await import('https://cdn.jsdelivr.net/npm/three@0.167.0/build/three.module.min.js'); }
        catch (e) { await dsDungeonEnter(d); return; }
    }
    if (!_dsWebGLAvailable()) { await dsDungeonEnter(d); return; }
    if (_dsDungeon) { _dsDungeon.destroy(); _dsDungeon = null; }
    if (_dsHub) { _dsHub.destroy(); _dsHub = null; }
    overlay.innerHTML = '';
    if (_dsAudio) { _dsAudio.init(); _dsAudio.setRoomMotif('hub'); }
    _dsHub = _dsBuildHub(_dsTHREE, overlay, d);
    _dsHub.start();
    if (opts && opts.celebrate && typeof _dsHub.triggerBossCelebration === 'function') {
        _dsHub.triggerBossCelebration(opts.streak || 0);
    }
}

function dsSetPassageSealed(passageId, sealed) {
    if (_dsHub && typeof _dsHub.setPassageSealed === 'function') {
        _dsHub.setPassageSealed(passageId, sealed);
    }
}
window.dsSetPassageSealed = dsSetPassageSealed;

// ── Diegetic error scenes (offline / update_required) ────────────────────────

async function dsDungeonEnterError(errorType, minVersion) {
    let overlay = document.getElementById('ds-dungeon-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ds-dungeon-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;';

    if (!_dsTHREE) {
        overlay.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#60a5fa;font-family:monospace;font-size:1.1rem;letter-spacing:.2em;">LOADING...</div>';
        try {
            _dsTHREE = await import('https://cdn.jsdelivr.net/npm/three@0.167.0/build/three.module.min.js');
        } catch (e) {
            overlay.innerHTML = '<div style="padding:2rem;color:#f87171;font-family:monospace;">ThreeJS failed to load.<br>Check your internet connection.</div>';
            return;
        }
    }

    if (_dsErrorScene) { _dsErrorScene.destroy(); _dsErrorScene = null; }
    overlay.innerHTML = '';
    if (_dsAudio) _dsAudio.init();
    if (_dsAudio) _dsAudio.setRoomMotif('hub');
    _dsErrorScene = _dsBuildErrorScene(_dsTHREE, overlay, errorType, minVersion);
    _dsErrorScene.start();
}

function _dsBuildErrorScene(THREE, overlay, errorType, minVersion) {
    const RENDER_W = 320, RENDER_H = 200;
    const HW = 6, HH = 3.5, HL = 8, HY = 0.35;

    const { renderer, canvas } = _dsRenderTarget(THREE, RENDER_W, RENDER_H);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 8, 14);
    const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.1, 50);
    camera.position.set(0, HY, 0);

    const ambientLight = new THREE.AmbientLight(0x221109);
    scene.add(ambientLight);
    const torch1 = new THREE.PointLight(0xff6622, 1.8, 9);
    torch1.position.set(-2, 1.2, -2);
    scene.add(torch1);
    const torch2 = new THREE.PointLight(0xff6622, 1.5, 9);
    torch2.position.set(2, 1.2, -4.5);
    scene.add(torch2);

    function stoneTexture(r, g, b, ru, rv) {
        return _dsStoneBasic(THREE, r, g, b, ru, rv, 0);
    }

    const wallTex = stoneTexture(45, 38, 30, 2, 2);
    const floorTex = stoneTexture(35, 29, 22, 3, 2);
    const ceilTex = stoneTexture(28, 23, 18, 3, 2);
    const darkTex = stoneTexture(20, 16, 12, 2, 2);
    const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTex });
    const ceilMat = new THREE.MeshLambertMaterial({ map: ceilTex });
    const darkMat = new THREE.MeshLambertMaterial({ map: darkTex });
    _dsApplyRealTex(THREE, wallMat,  'wall_brick.png',    3, 3, 0x6c645a);
    _dsApplyRealTex(THREE, floorMat, 'floor_granite.png', 4, 3, 0x5a564f);
    _dsApplyRealTex(THREE, ceilMat,  'floor_plate.png',   4, 3, 0x3a3732);

    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HW, HL), floorMat), { rotation: { x: -Math.PI / 2 }, position: new THREE.Vector3(0, 0, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HW, HL), ceilMat), { rotation: { x: Math.PI / 2 }, position: new THREE.Vector3(0, HH, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HL, HH), wallMat), { rotation: { y: Math.PI / 2 }, position: new THREE.Vector3(-HW / 2, HH / 2, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HL, HH), wallMat), { rotation: { y: -Math.PI / 2 }, position: new THREE.Vector3(HW / 2, HH / 2, -HL / 2) }));
    scene.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(HW, HH), darkMat), { position: new THREE.Vector3(0, HH / 2, -HL) }));
    const frontWall = new THREE.Mesh(new THREE.PlaneGeometry(HW, HH), darkMat);
    frontWall.rotation.y = Math.PI; frontWall.position.set(0, HH / 2, 0.5);
    scene.add(frontWall);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const raycasterObjects = [];
    const retryGlow = new THREE.PointLight(0xff4400, 0, 5);
    scene.add(retryGlow);
    let retryHovered = false;
    const disposables = [wallMat, floorMat, ceilMat, darkMat, wallTex, floorTex, ceilTex, darkTex];

    if (errorType === 'offline') {
        // Collapsed archway at the far end
        const frameMat = new THREE.MeshLambertMaterial({ color: 0x050505 });
        const rubbleMat = new THREE.MeshLambertMaterial({ color: 0x2a2218 });
        disposables.push(frameMat, rubbleMat);
        const fL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.4, 0.2), frameMat);
        fL.position.set(-0.9, 1.2, -(HL - 0.3)); scene.add(fL);
        const fR = fL.clone(); fR.position.set(0.9, 1.2, -(HL - 0.3)); scene.add(fR);
        const fTop = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.2, 0.2), frameMat);
        fTop.position.set(0, 2.4, -(HL - 0.3)); scene.add(fTop);
        [[0, 0.2, 0.65], [-0.3, 0.55, 0.5], [0.3, 0.5, 0.6], [-0.1, 0.95, 0.5], [0.2, 1.15, 0.42]].forEach(([rx, ry, rz]) => {
            const rb = new THREE.Mesh(new THREE.BoxGeometry(rz, rz * 0.6, rz * 0.5), rubbleMat);
            rb.position.set(rx, ry, -(HL - 0.35)); rb.rotation.y = rx * 1.7; scene.add(rb);
        });

        // Inscription above the gateway
        _dsCreateDiegeticSurface(THREE, {
            scene,
            position: [0, 2.15, -(HL - 0.08)],
            rotation: [0, 0, 0],
            size: [2.6, 0.7],
            draw(ctx, w, h) {
                ctx.fillStyle = '#140f0a';
                ctx.fillRect(0, 0, w, h);
                ctx.font = 'bold 19px monospace';
                ctx.fillStyle = '#c8a060';
                ctx.textAlign = 'center';
                ctx.fillText('CONNECTION SEVERED', w / 2, h * 0.38);
                ctx.font = '13px monospace';
                ctx.fillStyle = '#7a5a2a';
                ctx.fillText('RETURN WHEN READY', w / 2, h * 0.72);
            },
        });

        // Brazier retry interactable
        const pedestalMat = new THREE.MeshLambertMaterial({ color: 0x2c2218 });
        const brazierMat = new THREE.MeshLambertMaterial({ color: 0x6a3010, emissive: 0x3a1800 });
        disposables.push(pedestalMat, brazierMat);
        const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.5, 8), pedestalMat);
        pedestal.position.set(0, 0.25, -3.5); scene.add(pedestal);
        const brazier = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.2, 8), brazierMat);
        brazier.position.set(0, 0.55, -3.5); scene.add(brazier);
        raycasterObjects.push(brazier);
        retryGlow.position.set(0, 0.85, -3.5);

        const rlc = document.createElement('canvas');
        rlc.width = 128; rlc.height = 24;
        const rlctx = rlc.getContext('2d');
        rlctx.font = 'bold 13px monospace';
        rlctx.fillStyle = '#e08030';
        rlctx.textAlign = 'center'; rlctx.textBaseline = 'middle';
        rlctx.fillText('[E] RETRY', 64, 12);
        const rlTex = new THREE.CanvasTexture(rlc);
        rlTex.minFilter = rlTex.magFilter = THREE.NearestFilter;
        const rlMat = new THREE.MeshBasicMaterial({ map: rlTex, transparent: true });
        disposables.push(rlTex, rlMat);
        const retryLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.14), rlMat);
        retryLabel.position.set(0, 0.84, -3.5); scene.add(retryLabel);

    } else {
        // Stone tablet — update_required
        const tabletMat = new THREE.MeshLambertMaterial({ color: 0x221a10 });
        const baseMat = new THREE.MeshLambertMaterial({ color: 0x1a1208 });
        disposables.push(tabletMat, baseMat);
        const tablet = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.8, 0.18), tabletMat);
        tablet.position.set(0, 1.5, -3.5); scene.add(tablet);
        const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 0.4), baseMat);
        base.position.set(0, 0.125, -3.5); scene.add(base);

        _dsCreateDiegeticSurface(THREE, {
            scene,
            position: [0, 1.5, -3.41],
            rotation: [0, 0, 0],
            size: [2.1, 2.6],
            draw(ctx, w, h) {
                ctx.fillStyle = '#120e07';
                ctx.fillRect(0, 0, w, h);
                ctx.strokeStyle = '#6a4820';
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(14, 30); ctx.lineTo(w - 14, 30); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(14, h - 30); ctx.lineTo(w - 14, h - 30); ctx.stroke();
                ctx.font = 'bold 22px monospace';
                ctx.fillStyle = '#d4a030';
                ctx.textAlign = 'center';
                ctx.fillText('UPDATE', w / 2, h * 0.28);
                ctx.fillText('REQUIRED', w / 2, h * 0.42);
                ctx.font = '11px monospace';
                ctx.fillStyle = '#9a7228';
                ctx.fillText('THE DAILY CALLS FOR', w / 2, h * 0.57);
                ctx.fillText('A NEWER VESSEL.', w / 2, h * 0.66);
                if (minVersion) {
                    ctx.font = '10px monospace';
                    ctx.fillStyle = '#60481a';
                    ctx.fillText(`REQUIRED: v${minVersion}`, w / 2, h * 0.80);
                }
            },
        });
    }

    function exitToHost() {
        if (destroyed) return;
        destroy();
        _dsErrorScene = null;
        dsDungeonExit();
        ['loading', 'setlist', 'complete', 'leaderboard', 'passport', 'shop'].forEach(v => {
            const el = document.getElementById(`ds-${v}`);
            if (el) el.classList.add('hidden');
        });
        _dsInitialized = false;
        if (window._dsOrigShowScreen) {
            try { window._dsOrigShowScreen('app'); } catch (_e) {}
        }
    }

    function showExitConfirm() {
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        _dsRenderMenu(overlay, {
            title: 'LEAVE THE DAILY?',
            subtitle: 'Exit to the Slopsmith homepage.',
            items: [
                { label: 'YES, EXIT', action: () => { _dsCloseMenu(); _dsHubEscConfirmed = true; exitToHost(); } },
                { label: 'CANCEL', action: _dsCloseMenu },
            ],
            onCancel: _dsCloseMenu,
        });
    }

    function triggerRetry() {
        if (destroyed) return;
        destroy();
        _dsErrorScene = null;
        dsInit();
    }

    let destroyed = false;
    const state = { rafId: null };
    let torchT = 0;

    const onKey = (e) => {
        if (destroyed) return;
        if (e.key === 'Escape') {
            if (_dsHubEscConfirmed) { exitToHost(); e.preventDefault(); }
            else { showExitConfirm(); e.preventDefault(); }
        } else if ((e.key === 'e' || e.key === 'E') && errorType === 'offline') {
            triggerRetry(); e.preventDefault();
        }
    };
    window.addEventListener('keydown', onKey);

    canvas.addEventListener('click', () => {
        if (retryHovered && errorType === 'offline') triggerRetry();
    });

    canvas.addEventListener('mousemove', (e) => {
        if (errorType !== 'offline' || raycasterObjects.length === 0) return;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const nowHovered = raycaster.intersectObjects(raycasterObjects).length > 0;
        if (nowHovered !== retryHovered) {
            retryHovered = nowHovered;
            canvas.style.cursor = nowHovered ? 'pointer' : '';
        }
    });

    function loop() {
        if (destroyed) return;
        state.rafId = requestAnimationFrame(loop);
        torchT += 0.016;
        // Quake 10 Hz lightstyle flicker (torchT is seconds → ×1000 for ms).
        torch1.intensity = 1.8 * (0.72 + _dsSampleLightstyle('fire', torchT * 1000, 0) * 0.32);
        torch2.intensity = 1.5 * (0.72 + _dsSampleLightstyle('fire', torchT * 1000, 5.5) * 0.30);
        if (errorType === 'offline') {
            retryGlow.intensity = retryHovered
                ? (1.2 + Math.sin(torchT * 4) * 0.3)
                : (0.5 + Math.sin(torchT * 3) * 0.15);
        }
        renderer.render(scene, camera);
    }

    function start() {
        overlay.appendChild(canvas);
        state.rafId = requestAnimationFrame(loop);
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
        window.removeEventListener('keydown', onKey);
        disposables.forEach(m => { try { m.dispose(); } catch (_e) {} });
        renderer.dispose();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    _dsTextureAllSurfaces(THREE, scene, disposables);

    return { start, destroy };
}

function _dsBuildDungeon(THREE, container, d) {
    const map = d.map;
    const RENDER_W = 320, RENDER_H = 200;
    // World scale: geometry is authored in small units, but Quake's physics
    // constants are used *literally* (maxspeed 320, friction 4, cl_bob 0.02, …) —
    // they only feel right at Quake's scale. The whole world renders inside a
    // group scaled up to Quake units; the camera moves through it in raw Quake
    // units. Geometry/props/doors keep their small literals (the group scales
    // them); only camera-space quantities, light ranges, and fog are × WS.
    const WS = 64;

    // Navigation state
    const state = {
        nodeId: localStorage.getItem('ds_dun_node_' + d.date) || map.start,
        faceIdx: 0,
        phase: 'idle', // idle | moving | facing | encounter
        moveTween: 0,
        nextId: null,
        rafId: null,
    };

    // ── Three.js setup ────────────────────────────────────────────────────────
    const { renderer, canvas } = _dsRenderTarget(THREE, RENDER_W, RENDER_H);

    const scene = new THREE.Scene();
    // Everything except the camera lives under this scaled group (see WS above).
    const world = new THREE.Group();
    world.scale.setScalar(WS);
    scene.add(world);
    // The persistent floorplan geometry (floor/ceil/walls/rubble, ADR 0012) lives
    // directly under `world`. The transient *current-room dressing* — signature
    // prop, torches, doorGlow, the interact prompt — lives under `roomGroup`,
    // which is repositioned to whichever room the player currently occupies. The
    // prop/torch builders author their coords in a room-local frame; moving the
    // group is what places that dressing at the occupied room's center.
    const roomGroup = new THREE.Group();
    world.add(roomGroup);
    scene.fog = new THREE.Fog(0x000000, 9 * WS, 14 * WS);
    // Quake default fov is 90 *horizontal*; three.js wants vertical fov. CalcFov
    // (gl_screen.js): fov_y = atan(h / (w / tan(fov_x/2))) → 64° at 320×200.
    const camera = new THREE.PerspectiveCamera(64, RENDER_W / RENDER_H, 4, 6000);
    camera.position.set(0, 0.3 * WS, 0);

    // Lights live in the scaled world. PointLight.distance is world-space and is
    // NOT scaled by the parent group's transform, so ranges are × WS by hand.
    const ambientLight = new THREE.AmbientLight(0x221109);
    world.add(ambientLight);
    // decay 0: falloff windows smoothly to 0 at `distance` instead of inverse-
    // square, so intensities tuned for the small geometry still light the world
    // once distance is scaled by WS. (r155+ PointLight defaults to decay 2.)
    const torch1 = new THREE.PointLight(0xff6622, 2.2, 10 * WS, 0);
    torch1.position.set(-1.6, 1.0, -2);
    roomGroup.add(torch1);
    const torch2 = new THREE.PointLight(0xff6622, 1.8, 10 * WS, 0);
    torch2.position.set(1.6, 1.0, -5);
    roomGroup.add(torch2);
    const doorGlow = new THREE.PointLight(0x1d4ed8, 2, 6 * WS, 0);
    doorGlow.position.set(0, 0.3, -8);
    roomGroup.add(doorGlow);
    // Player-following light (ADR 0012): the per-room torches light the rooms, but
    // the contiguous corridors / antechamber between them would be pitch black with
    // only room-local lights. A soft warm lamp tracks the camera so the player can
    // always see the passage they're walking. Kept dim so room torches still pop.
    const playerLight = new THREE.PointLight(0xffce96, 1.7, 8.5 * WS, 0);
    world.add(playerLight);

    // ── Visible torch fire ────────────────────────────────────────────────────
    // The corridor torches were bare floating PointLights — pools of light with
    // no source. Give each a free-standing iron torch stand with an animated
    // flame and rising embers (Quake's flames are a visible particle fire, never
    // an invisible light). Parented to the light so it follows wherever a theme
    // repositions the torch; `flamesVisible` hides them in rooms that have their
    // own fire dressing (boss perimeter stands, rest campfire, mystery glow).
    const _WHITE = new THREE.Color(0xffffff);
    const flameDisposables = [];   // shared geometries + per-flame materials
    const _poleGeo = new THREE.CylinderGeometry(0.035, 0.05, 2.0, 6);
    const _bowlGeo = new THREE.CylinderGeometry(0.13, 0.08, 0.14, 8);
    const _coreGeo = new THREE.ConeGeometry(0.1, 0.34, 5);
    const _tipGeo  = new THREE.ConeGeometry(0.05, 0.2, 4);
    const _poleMat = new THREE.MeshLambertMaterial({ color: 0x18130f });
    const _bowlMat = new THREE.MeshLambertMaterial({ color: 0x2a1a10, emissive: 0x160a04 });
    [_poleGeo, _bowlGeo, _coreGeo, _tipGeo, _poleMat, _bowlMat].forEach(x => flameDisposables.push(x));
    function makeTorchFlame() {
        const g = new THREE.Group();
        // Light sits at world y = 1.0; floor is CY - CH/2 below it.
        const floorLocalY = (CY - CH / 2) - 1.0;
        const pole = new THREE.Mesh(_poleGeo, _poleMat);
        pole.position.y = floorLocalY + 1.0;   // centre of the 2.0-tall pole
        g.add(pole);
        const bowl = new THREE.Mesh(_bowlGeo, _bowlMat);
        bowl.position.y = -0.16;
        g.add(bowl);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.92, fog: false, depthWrite: false });
        const tipMat  = new THREE.MeshBasicMaterial({ color: 0xffee99, transparent: true, opacity: 0.95, fog: false, depthWrite: false });
        flameDisposables.push(coreMat, tipMat);
        const core = new THREE.Mesh(_coreGeo, coreMat); core.position.y = 0.02; g.add(core);
        const tip  = new THREE.Mesh(_tipGeo, tipMat);   tip.position.y = 0.16;  g.add(tip);
        // Rising embers — a few additive specks that drift up and recycle.
        const n = 9, ep = new Float32Array(n * 3), ev = [];
        for (let i = 0; i < n; i++) {
            ep[i*3] = (Math.random() - 0.5) * 0.14;
            ep[i*3+1] = Math.random() * 0.8;
            ep[i*3+2] = (Math.random() - 0.5) * 0.14;
            ev.push(0.4 + Math.random() * 0.5);
        }
        const eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
        const em = new THREE.PointsMaterial({ color: 0xff7a22, size: 2.2, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
        flameDisposables.push(eg, em);
        const embers = new THREE.Points(eg, em);
        g.add(embers);
        g._core = core; g._tip = tip; g._embers = embers; g._emberVel = ev;
        return g;
    }
    // (instantiated below, once the corridor constants CY/CH it reads exist)

    // ── Procedural stone texture ──────────────────────────────────────────────
    function stoneTexture(r, g, b, ru, rv) {
        return _dsStoneBasic(THREE, r, g, b, ru, rv);
    }

    const wallMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(38, 32, 28, 3, 1) });
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x5a564f, map: stoneTexture(25, 22, 18, 2, 4) });
    const ceilMat  = new THREE.MeshLambertMaterial({ color: 0x3a3732, map: stoneTexture(18, 16, 14, 2, 4) });
    const backMat  = new THREE.MeshLambertMaterial({ map: stoneTexture(22, 18, 15, 2, 1) });
    _dsApplyRealTex(THREE, wallMat,  'wall_stone.png',    4, 2, 0x6c655c);
    _dsApplyRealTex(THREE, backMat,  'wall_castle.png',   3, 2, 0x6c645a);
    // floor_granite + floor_plate are applied in buildFloorplan once the spanning
    // plane's size is known, so the tile density is right. Per-room mood then comes
    // from setRoomMats() tinting these shared materials (null tint = leave .color).

    // ── Corridor geometry ─────────────────────────────────────────────────────
    // Wider corridor (CW=8) so multiple fanned doors at the back wall are visible
    // and turning to face them produces meaningful angle changes.
    const CW = 8, CH = 3, CL = 10, CY = 0.3;
    const EYE = CY * WS;   // camera eye height in world (Quake) units
    const FLOOR_Y = CY - CH / 2, CEIL_Y = CY + CH / 2;
    // Now that CY/CH exist, build the standing torch fires (see makeTorchFlame).
    const flame1 = makeTorchFlame(); torch1.add(flame1);
    const flame2 = makeTorchFlame(); torch2.add(flame2);
    const torchFlames = [flame1, flame2];
    let flamesVisible = true;   // set per-theme in applyRoomTheme

    // ── Contiguous floorplan layout constants (ADR 0012) ──────────────────────
    // World-local units (the world group scales everything × WS). Rooms are deep
    // so the signature props — authored extending toward −Z (e.g. treasure plinth
    // at z≈−6.5) — sit near each room's far wall; the player walks forward through
    // the room to reach the prop and the exits beyond it. Spacing keeps adjacent
    // rows from overlapping. The vertical frame (FLOOR_Y/CEIL_Y/EYE) matches the
    // prop builders so dressing sits on the floor without per-prop adjustment.
    const CELL_X = 12, CELL_Z = 22;     // room-center spacing (lateral, forward)
    const ROOM_HW = 4.5, ROOM_HD = 7.5; // standard room half-extents
    const BOSS_HW = 7.0, BOSS_HD = 9.0; // the boss hall is larger
    const COR_HW = 2.0;                 // corridor half-width
    const TILE = 1.0;                   // occupancy tile size (world-local)
    const PLAYER_R = 1.1;               // collision radius (world-local)

    const roomMeshes = {};   // { floor, ceil } big spanning planes (built in buildFloorplan)
    const doorFrameMat = new THREE.MeshLambertMaterial({ color: 0x080808 });
    // Floorplan state (populated by buildFloorplan):
    const rooms = {};        // id -> { node, x, z, hw, hd, anchor:{x,z} }
    const corridors = [];    // { aId, bId, ax,bx, aFar,bNear,midZ, mouthX,mouthZ, open, gate }
    let antechamber = null;  // { x0,x1,z0,z1 } spawn box behind the entrance rooms
    let wallMesh = null;     // merged wall BufferGeometry mesh (rebuilt on section open)
    let occ = null;          // { x0, z0, nx, nz, cells:Uint8Array }
    const rubbleGates = [];  // { corridor, group } live rubble piles (for disposal)
    const explosions = [];   // active debris/spark bursts being animated
    let camShake = 0;        // decaying rotational camera-kick from nearby detonations
    const _floorplanDisposables = []; // geometries/materials/textures to free on destroy

    // ── Room theming (per-node-type visual dressing) ──────────────────────────
    // Contiguous floorplan (ADR 0012): walls are one shared merged mesh, so per-
    // room wall texture swapping is gone — room mood is carried by lighting + prop.
    // Floor/ceil are a single shared real-textured plane (granite/plate); per-room
    // mood rides on tinting those shared materials rather than swapping in a
    // per-theme procedural material, so every room keeps a real texture and fog
    // bounds the view so it reads as that room's ground. (Replaced the old
    // themeMats/*StoneTexture procedural-material builders.)
    const ROOM_FLOOR_TINT = {
        default: 0x6a635a, forced: 0x6a5848, elite: 0x6e3a34, boss: 0x5a302c,
        treasure: 0x72603a, rest: 0x5e5a40, mystery: 0x4a3e64, shop: 0x726048,
    };
    const ROOM_CEIL_TINT = {
        default: 0x46423c, forced: 0x4a3e30, elite: 0x4a2824, boss: 0x3c201e,
        treasure: 0x4c4026, rest: 0x403c2c, mystery: 0x322a44, shop: 0x4a4032,
    };
    function setRoomMats(type) {
        const ft = ROOM_FLOOR_TINT[type] != null ? ROOM_FLOOR_TINT[type] : ROOM_FLOOR_TINT.default;
        const ct = ROOM_CEIL_TINT[type]  != null ? ROOM_CEIL_TINT[type]  : ROOM_CEIL_TINT.default;
        floorMat.color.setHex(ft);
        ceilMat.color.setHex(ct);
    }

    // Boss room scale factors (throne hall is wider and taller than standard corridor)
    const BW = 12, BH = 4.5;

    // Perimeter torch lights for boss room — initially unlit; slice 007 ignites them
    const bossPerimTorches = [
        new THREE.PointLight(0xff4411, 0, 7 * WS, 0),
        new THREE.PointLight(0xff4411, 0, 7 * WS, 0),
        new THREE.PointLight(0xff4411, 0, 7 * WS, 0),
        new THREE.PointLight(0xff4411, 0, 7 * WS, 0),
    ];
    bossPerimTorches.forEach(l => roomGroup.add(l));
    // Expose for slice 007 boss-clear celebration
    window._dsDungeonBossTorches = bossPerimTorches;

    let roomProp = null;
    let campfireLight = null;

    function clearRoomProp() {
        if (roomProp) { roomGroup.remove(roomProp); disposeMeshGroup(roomProp); roomProp = null; }
        if (campfireLight) { roomGroup.remove(campfireLight); campfireLight = null; }
    }

    function disposeMeshGroup(obj) {
        obj.traverse(c => {
            if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
        });
    }

    function buildForcedProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;

        // Materials — black tolex cab/head, brass piping, gold control panel.
        const cabMat    = new THREE.MeshLambertMaterial({ color: 0x141414 });
        const grilleMat = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });
        const coneMat   = new THREE.MeshLambertMaterial({ color: 0x1c1c1c });
        const pipingMat = new THREE.MeshLambertMaterial({ color: 0xb8a060 });
        const goldMat   = new THREE.MeshLambertMaterial({ color: 0xc8a020, emissive: 0x2a2000 });
        const knobMat   = new THREE.MeshLambertMaterial({ color: 0x202020 });
        const logoMat   = new THREE.MeshLambertMaterial({ color: 0xe8e0d0, emissive: 0x201c14 });
        const ledMat    = new THREE.MeshLambertMaterial({ color: 0xff3020, emissive: 0xaa1000 });

        const xC = 0, zC = -2.6;

        // ── 4×12 speaker cabinet ──
        const cabW = 0.70, cabH = 0.78, cabD = 0.42;
        const cab = new THREE.Mesh(new THREE.BoxGeometry(cabW, cabH, cabD), cabMat);
        cab.position.set(xC, floorY + cabH / 2, zC);
        g.add(cab);
        const cabFront = zC + cabD / 2;

        // Brass/white piping rails around the cab front edge
        [floorY + 0.02, floorY + cabH - 0.02].forEach(py => {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(cabW, 0.025, 0.04), pipingMat);
            rail.position.set(xC, py, cabFront);
            g.add(rail);
        });
        [-cabW / 2 + 0.02, cabW / 2 - 0.02].forEach(px => {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.025, cabH, 0.04), pipingMat);
            rail.position.set(xC + px, floorY + cabH / 2, cabFront);
            g.add(rail);
        });

        // Grille cloth (inset dark panel)
        const grille = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.60, 0.02), grilleMat);
        grille.position.set(xC, floorY + 0.40, cabFront + 0.005);
        g.add(grille);

        // Four speakers (2×2), cones facing the player
        [[-0.14, 0.54], [0.14, 0.54], [-0.14, 0.26], [0.14, 0.26]].forEach(([ox, oy]) => {
            const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.02, 12), coneMat);
            cone.rotation.x = Math.PI / 2;
            cone.position.set(xC + ox, floorY + oy, cabFront + 0.02);
            g.add(cone);
            const dust = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), knobMat);
            dust.position.set(xC + ox, floorY + oy, cabFront + 0.035);
            g.add(dust);
        });

        // Script logo plate at the top of the grille
        const logo = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.06, 0.012), logoMat);
        logo.position.set(xC, floorY + 0.70, cabFront + 0.02);
        g.add(logo);

        // ── Amp head sitting on the cab ──
        const headW = 0.72, headH = 0.26, headD = 0.34;
        const headY = floorY + cabH + headH / 2;
        const head = new THREE.Mesh(new THREE.BoxGeometry(headW, headH, headD), cabMat);
        head.position.set(xC, headY, zC);
        g.add(head);
        const headFront = zC + headD / 2;

        // Piping trim along the head's top edge
        const headTrim = new THREE.Mesh(new THREE.BoxGeometry(headW + 0.02, 0.025, headD + 0.02), pipingMat);
        headTrim.position.set(xC, floorY + cabH + headH, zC);
        g.add(headTrim);

        // Gold control panel + row of knobs + power LED
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.10, 0.02), goldMat);
        panel.position.set(xC, headY + 0.03, headFront + 0.005);
        g.add(panel);
        for (let i = 0; i < 6; i++) {
            const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8), knobMat);
            knob.rotation.x = Math.PI / 2;
            knob.position.set(xC - 0.25 + i * 0.10, headY + 0.03, headFront + 0.02);
            g.add(knob);
        }
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.012), ledMat);
        led.position.set(xC + 0.30, headY + 0.03, headFront + 0.015);
        g.add(led);

        // ── Electric guitar on an A-frame stand, beside the stack ──
        const stand = new THREE.Group();
        stand.position.set(-0.95, floorY, -2.4);
        const standMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
        const legL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.62, 0.03), standMat);
        legL.position.set(-0.12, 0.31, 0.0); legL.rotation.z = 0.20; stand.add(legL);
        const legR = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.62, 0.03), standMat);
        legR.position.set(0.12, 0.31, 0.0); legR.rotation.z = -0.20; stand.add(legR);
        const legB = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.60, 0.03), standMat);
        legB.position.set(0, 0.30, -0.16); legB.rotation.x = -0.28; stand.add(legB);
        const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.10), standMat);
        cradle.position.set(0, 0.10, 0.05); stand.add(cradle);
        const yoke = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.04), standMat);
        yoke.position.set(0, 0.55, 0.0); stand.add(yoke);

        const gtr = new THREE.Group();
        const bodyMat = new THREE.MeshLambertMaterial({ color: 0xb02828 });
        const pgMat   = new THREE.MeshLambertMaterial({ color: 0x0c0c0c });
        const neckMat = new THREE.MeshLambertMaterial({ color: 0xc9a063 });
        const fbMat   = new THREE.MeshLambertMaterial({ color: 0x2a1a0c });
        const hwMat   = new THREE.MeshLambertMaterial({ color: 0x303030 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.40, 0.05), bodyMat);
        body.position.set(0, 0.20, 0); gtr.add(body);
        [[-0.15, 0.10], [0.15, 0.10], [-0.15, 0.30], [0.15, 0.30]].forEach(([bx, by]) => {
            const lobe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 8), bodyMat);
            lobe.rotation.x = Math.PI / 2;
            lobe.position.set(bx, by, 0); gtr.add(lobe);
        });
        const pg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.055), pgMat);
        pg.position.set(0.03, 0.18, 0.004); gtr.add(pg);
        const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.06), hwMat);
        bridge.position.set(0, 0.07, 0.01); gtr.add(bridge);
        [0.16, 0.26].forEach(py => {
            const pu = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.06), hwMat);
            pu.position.set(0, py, 0.01); gtr.add(pu);
        });
        const neck = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.58, 0.045), neckMat);
        neck.position.set(0, 0.69, 0); gtr.add(neck);
        const fb = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.56, 0.02), fbMat);
        fb.position.set(0, 0.69, 0.025); gtr.add(fb);
        const hs = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.035), neckMat);
        hs.position.set(0, 1.03, 0.005); hs.rotation.x = 0.18; gtr.add(hs);
        // Seat the guitar in the cradle and lean it back into the yoke
        gtr.position.set(0, 0.12, 0.05);
        gtr.rotation.x = -0.12;
        stand.add(gtr);

        g.add(stand);
        return g;
    }

    function buildEliteProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const wallX  = CW / 2 - 0.25;

        // Spike trim — low-poly cones along both side walls at floor level
        const spikeMat = new THREE.MeshLambertMaterial({ color: 0x1a0808, emissive: 0x0d0000 });
        const spikeH = 0.38, spikeR = 0.11, spikeSegs = 4, spikeCount = 8;
        const zStart = -1.2, zEnd = -8.5;
        for (let i = 0; i < spikeCount; i++) {
            const z = zStart + (i / (spikeCount - 1)) * (zEnd - zStart);
            for (const xs of [-1, 1]) {
                const spike = new THREE.Mesh(new THREE.ConeGeometry(spikeR, spikeH, spikeSegs), spikeMat);
                spike.position.set(xs * wallX, floorY + spikeH / 2, z);
                g.add(spike);
            }
        }

        // Broken sword embedded in left wall — blade and guard
        const bladeMat = new THREE.MeshLambertMaterial({ color: 0x585868, emissive: 0x0a0808 });
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.82, 0.12), bladeMat);
        blade.position.set(-wallX + 0.05, CY + 0.08, -2.5);
        blade.rotation.z = Math.PI / 6;
        g.add(blade);
        const guardMat = new THREE.MeshLambertMaterial({ color: 0x281810 });
        const guard = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.06, 0.10), guardMat);
        guard.position.set(-wallX + 0.09, CY - 0.13, -2.5);
        guard.rotation.z = Math.PI / 6;
        g.add(guard);

        // Stained altar — stone base with blood-dark top slab. Centred so the
        // player walks up to it head-on (the spike trim + embedded sword stay
        // wall-mounted as side dressing).
        const altarBaseMat = new THREE.MeshLambertMaterial({ color: 0x1a0c0c });
        const altarBase = new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.50, 0.50), altarBaseMat);
        altarBase.position.set(0, floorY + 0.25, -2.8);
        g.add(altarBase);
        const altarTopMat = new THREE.MeshLambertMaterial({ color: 0x3a0a0a, emissive: 0x1a0000 });
        const altarTop = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.08, 0.54), altarTopMat);
        altarTop.position.set(0, floorY + 0.54, -2.8);
        g.add(altarTop);

        return g;
    }

    function buildBossProp(bossCleared) {
        const g = new THREE.Group();
        const floorY = CY - BH / 2;

        const stoneMat = new THREE.MeshLambertMaterial({ color: 0x1e1410 });
        const darkMat  = new THREE.MeshLambertMaterial({ color: 0x140e0c });
        const goldMat  = new THREE.MeshLambertMaterial({ color: 0x7a5418, emissive: 0x1a0e00 });
        const slabMat  = new THREE.MeshLambertMaterial({ color: 0x100c0c, emissive: 0x0a0000 });

        // Raised dais under throne
        const dais = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.22, 2.2), stoneMat);
        dais.position.set(0, floorY + 0.11, -7.2);
        g.add(dais);

        // Throne seat
        const seatY = floorY + 0.22 + 0.18;
        const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.36, 1.3), darkMat);
        seat.position.set(0, seatY, -7.2);
        g.add(seat);

        // Throne backrest
        const backY = seatY + 0.18 + 1.1;
        const backRest = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.2, 0.24), darkMat);
        backRest.position.set(0, backY, -7.75);
        g.add(backRest);

        // Armrests
        [-0.78, 0.78].forEach(ax => {
            const arm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.4, 1.1), darkMat);
            arm.position.set(ax, seatY + 0.18 + 0.2, -7.2);
            g.add(arm);
        });

        // Crown finials — three gold spires on backrest top
        [[-0.55, 0], [0, 0.12], [0.55, 0]].forEach(([fx, fExtra]) => {
            const fin = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.55 + fExtra, 6), goldMat);
            fin.position.set(fx, backY + 1.1 + 0.18 + fExtra / 2, -7.75);
            g.add(fin);
        });

        // Columns — two pairs flanking the throne
        const colMat = new THREE.MeshLambertMaterial({ color: 0x1c1010 });
        const capMat = new THREE.MeshLambertMaterial({ color: 0x161010 });
        const colH = BH - 0.05;
        const colBaseY = floorY + colH / 2;
        [[-5.0, -2.0], [5.0, -2.0], [-5.0, -6.0], [5.0, -6.0]].forEach(([cx, cz]) => {
            const col = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.30, colH, 8), colMat);
            col.position.set(cx, colBaseY, cz);
            g.add(col);
            const cap = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.18, 0.78), capMat);
            cap.position.set(cx, floorY + colH + 0.09, cz);
            g.add(cap);
            const base = new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.16, 0.70), capMat);
            base.position.set(cx, floorY + 0.08, cz);
            g.add(base);
        });

        // Perimeter torch stands — positioned at same coords as bossPerimTorches
        const poleMat = new THREE.MeshLambertMaterial({ color: 0x2a1a10 });
        const headMat = new THREE.MeshLambertMaterial({ color: 0x100808 });
        const torchPositions = [[-4.5, -1.6], [4.5, -1.6], [-4.5, -6.4], [4.5, -6.4]];
        torchPositions.forEach(([tx, tz], i) => {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.7, 6), poleMat);
            pole.position.set(tx, floorY + 0.85, tz);
            g.add(pole);
            const head = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.08, 0.24, 8), headMat);
            head.position.set(tx, floorY + 1.75, tz);
            g.add(head);
            bossPerimTorches[i].position.set(tx, floorY + 1.9, tz);
            if (bossCleared) bossPerimTorches[i].intensity = 0.8;
        });

        // Streak slab — stone tile on floor for slice 007 inscription
        const slab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.09, 1.1), slabMat);
        slab.position.set(0, floorY + 0.045, -4.8);
        g.add(slab);

        return g;
    }

    function buildTreasureProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;

        const stoneMat      = new THREE.MeshLambertMaterial({ color: 0x3a2c18 });
        const plinthCapMat  = new THREE.MeshLambertMaterial({ color: 0x2e2214 });
        const goldMat       = new THREE.MeshLambertMaterial({ color: 0xd4920a, emissive: 0x3a2400 });
        const goldBrightMat = new THREE.MeshLambertMaterial({ color: 0xf0b424, emissive: 0x4a3000 });
        const woodMat       = new THREE.MeshLambertMaterial({ color: 0x3d2208 });
        const chestGoldMat  = new THREE.MeshLambertMaterial({ color: 0xc89010, emissive: 0x1a0c00 });
        const gemRedMat     = new THREE.MeshLambertMaterial({ color: 0xcc2020, emissive: 0x3a0000 });
        const gemBlueMat    = new THREE.MeshLambertMaterial({ color: 0x2040c0, emissive: 0x000820 });
        const gemGreenMat   = new THREE.MeshLambertMaterial({ color: 0x10a040, emissive: 0x001808 });

        // Stone plinth — focal point at room center-back
        const pz = -6.5;
        const plinthBase = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 0.8), stoneMat);
        plinthBase.position.set(0, floorY + 0.2, pz);
        g.add(plinthBase);
        const plinthCap = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 1.0), plinthCapMat);
        plinthCap.position.set(0, floorY + 0.43, pz);
        g.add(plinthCap);

        // Gold pile — low-poly mound of coins and lumps on plinth top
        const pileY = floorY + 0.46;
        const pileOffsets = [
            [ 0.00, 0.10,  0.00], [-0.24, 0.06,  0.08], [ 0.24, 0.06, -0.08],
            [-0.14, 0.18, -0.06], [ 0.16, 0.18,  0.06], [ 0.00, 0.28,  0.00],
            [-0.30, 0.04, -0.14], [ 0.28, 0.04,  0.14], [-0.18, 0.10,  0.16],
            [ 0.20, 0.10, -0.14], [ 0.00, 0.08, -0.20], [ 0.10, 0.08,  0.22],
        ];
        const pileRadii = [0.14, 0.11, 0.11, 0.09, 0.09, 0.08, 0.08, 0.08, 0.07, 0.07, 0.09, 0.07];
        pileOffsets.forEach(([ox, oy, oz], i) => {
            const mat = (i % 3 === 0) ? goldBrightMat : goldMat;
            const lump = new THREE.Mesh(new THREE.SphereGeometry(pileRadii[i], 4, 3), mat);
            lump.position.set(ox, pileY + oy, pz + oz);
            g.add(lump);
        });

        // Gem accents scattered in the pile
        [[0.18, 0.22, -0.10, gemRedMat], [-0.20, 0.15, 0.12, gemBlueMat], [0.05, 0.30, 0.08, gemGreenMat]].forEach(([gx, gy, gz, mat]) => {
            const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.055), mat);
            gem.position.set(gx, pileY + gy, pz + gz);
            g.add(gem);
        });

        // Warm point light above the pile — gold glow on surrounding walls
        const pileGlow = new THREE.PointLight(0xffcc44, 1.6, 5.0 * WS, 0);
        pileGlow.position.set(0, pileY + 0.55, pz);
        g.add(pileGlow);

        // Treasure chests — one per side, lids cracked open
        const chestZ = -4.5;
        [[-1.8, 1], [1.8, -1]].forEach(([cx, flip]) => {
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.36, 0.46), woodMat);
            body.position.set(cx, floorY + 0.18, chestZ);
            g.add(body);
            const trim = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.48), chestGoldMat);
            trim.position.set(cx, floorY + 0.18, chestZ);
            g.add(trim);
            const lid = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.48), woodMat);
            lid.position.set(cx, floorY + 0.45, chestZ - 0.04 * flip);
            lid.rotation.x = -0.25 * flip;
            g.add(lid);
            const hasp = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.08, 0.06), chestGoldMat);
            hasp.position.set(cx, floorY + 0.38, chestZ - 0.23);
            g.add(hasp);
            // Small coin spill on floor
            const spill = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 8), goldMat);
            spill.position.set(cx + 0.28 * flip, floorY + 0.01, chestZ + 0.1 * flip);
            g.add(spill);
        });

        return g;
    }

    function buildMysteryProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const altarZ = -6.0;

        // Stone altar base
        const altarBaseMat = new THREE.MeshLambertMaterial({ color: 0x1a1226 });
        const altarBase = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.7), altarBaseMat);
        altarBase.position.set(0, floorY + 0.275, altarZ);
        g.add(altarBase);

        // Altar slab top
        const altarCapMat = new THREE.MeshLambertMaterial({ color: 0x251838, emissive: 0x080412 });
        const altarCap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.80), altarCapMat);
        altarCap.position.set(0, floorY + 0.59, altarZ);
        g.add(altarCap);

        // Glowing orb — the unidentifiable object
        const orbMat = new THREE.MeshLambertMaterial({ color: 0xb060f0, emissive: 0x6010c0 });
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), orbMat);
        orb.position.set(0, floorY + 0.72, altarZ);
        g.add(orb);

        // Wispy halo rings encircling the orb
        const haloMat = new THREE.MeshLambertMaterial({ color: 0x7040c0, emissive: 0x3010a0, transparent: true, opacity: 0.55 });
        [[0, 0.5], [1, 1.6], [2, 2.7]].forEach(([i, rot]) => {
            const halo = new THREE.Mesh(new THREE.TorusGeometry(0.20 + i * 0.06, 0.012, 4, 12), haloMat);
            halo.rotation.x = Math.PI / 2 + rot;
            halo.rotation.z = rot;
            halo.position.set(0, floorY + 0.72, altarZ);
            g.add(halo);
        });

        // Altar glow light — violet, slow pulse driven by render loop
        const altarGlow = new THREE.PointLight(0x9940f0, 1.0, 6.0 * WS, 0);
        altarGlow.position.set(0, floorY + 0.90, altarZ);
        g.add(altarGlow);
        g._altarGlow = altarGlow;

        return g;
    }

    function buildRestProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const fireX = 0, fireZ = -3.2;

        // Fire pit ring — small stone blocks in a circle
        const pitStoneMat = new THREE.MeshLambertMaterial({ color: 0x3a3228 });
        const pitR = 0.32, stoneCount = 8;
        for (let i = 0; i < stoneCount; i++) {
            const angle = (i / stoneCount) * Math.PI * 2;
            const stone = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), pitStoneMat);
            stone.position.set(fireX + Math.cos(angle) * pitR, floorY + 0.04, fireZ + Math.sin(angle) * pitR);
            stone.rotation.y = angle;
            g.add(stone);
        }

        // Logs — two crossed cylinders
        const logMat = new THREE.MeshLambertMaterial({ color: 0x2a1e10 });
        const log1 = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.70, 6), logMat);
        log1.position.set(fireX, floorY + 0.055, fireZ);
        log1.rotation.z = Math.PI / 2;
        log1.rotation.y = 0.4;
        g.add(log1);
        const log2 = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.70, 6), logMat);
        log2.position.set(fireX, floorY + 0.055, fireZ);
        log2.rotation.z = Math.PI / 2;
        log2.rotation.y = -0.4;
        g.add(log2);

        // Embers — glowing disc at base of fire
        const emberMat = new THREE.MeshLambertMaterial({ color: 0xff4400, emissive: 0xcc2200 });
        const embers = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.04, 8), emberMat);
        embers.position.set(fireX, floorY + 0.02, fireZ);
        g.add(embers);

        // Flame — low-poly cone
        const flameMat = new THREE.MeshLambertMaterial({ color: 0xff5500, emissive: 0xff2200, transparent: true, opacity: 0.88 });
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.38, 5), flameMat);
        flame.position.set(fireX, floorY + 0.19 + 0.38 / 2, fireZ);
        g.add(flame);

        // Inner flame tip — brighter, narrower
        const flameTipMat = new THREE.MeshLambertMaterial({ color: 0xffdd00, emissive: 0xffaa00, transparent: true, opacity: 0.9 });
        const flameTip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.24, 4), flameTipMat);
        flameTip.position.set(fireX, floorY + 0.19 + 0.38 + 0.24 / 2 - 0.08, fireZ);
        g.add(flameTip);

        // Bedroll — flat mattress near the fire
        const bedrollMat = new THREE.MeshLambertMaterial({ color: 0x4a3828 });
        const bedroll = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.08, 0.40), bedrollMat);
        bedroll.position.set(-1.8, floorY + 0.04, -2.5);
        bedroll.rotation.y = 0.3;
        g.add(bedroll);

        // Pillow
        const pillowMat = new THREE.MeshLambertMaterial({ color: 0x3a2e24 });
        const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.34), pillowMat);
        pillow.position.set(-1.58, floorY + 0.085, -2.22);
        pillow.rotation.y = 0.3;
        g.add(pillow);

        return g;
    }

    function buildShopProp() {
        const g = new THREE.Group();
        const floorY = CY - CH / 2;
        const counterZ = -6.2;

        const counterMat = new THREE.MeshLambertMaterial({ color: 0x3a2c1e });
        const clerkMat   = new THREE.MeshLambertMaterial({ color: 0x0d0a08 });
        const shelfMat   = new THREE.MeshLambertMaterial({ color: 0x2e2010 });
        const itemMatA   = new THREE.MeshLambertMaterial({ color: 0x8a5a2a, emissive: 0x0e0600 });
        const itemMatB   = new THREE.MeshLambertMaterial({ color: 0x4a3a6a, emissive: 0x050010 });
        const itemMatC   = new THREE.MeshLambertMaterial({ color: 0x2a5a3a, emissive: 0x001808 });

        // Counter — wide surface at room focal point
        const counterTop = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.10, 0.80), counterMat);
        counterTop.position.set(0, floorY + 0.90, counterZ);
        g.add(counterTop);
        const counterBody = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.78, 0.70), counterMat);
        counterBody.position.set(0, floorY + 0.39, counterZ);
        g.add(counterBody);

        // Clerk silhouette — low-poly humanoid behind counter, no face
        const clerkZ = counterZ - 0.55;
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.18), clerkMat);
        torso.position.set(0, floorY + 1.42, clerkZ);
        g.add(torso);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.18), clerkMat);
        head.position.set(0, floorY + 1.87, clerkZ);
        g.add(head);
        const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.12, 0.20), clerkMat);
        shoulders.position.set(0, floorY + 1.69, clerkZ);
        g.add(shoulders);
        [-0.22, 0.22].forEach(ax => {
            const arm = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.12, 0.48), clerkMat);
            arm.position.set(ax, floorY + 0.93, counterZ - 0.14);
            g.add(arm);
        });

        // Shelves along both side walls with generic low-poly items
        const lwX = -CW / 2 + 0.03;
        const rwX =  CW / 2 - 0.03;
        const shelfLevels = [floorY + 1.50, floorY + 1.02];
        const shelfPositions = [-2.8, -4.8];
        const shelfItemMats = [itemMatA, itemMatB, itemMatC];
        [[lwX, 1], [rwX, -1]].forEach(([wx, side]) => {
            shelfLevels.forEach(sy => {
                shelfPositions.forEach(sp => {
                    const board = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 1.40), shelfMat);
                    board.position.set(wx + side * 0.03, sy, sp);
                    g.add(board);
                    shelfItemMats.forEach((mat, k) => {
                        const ih = 0.14 + k * 0.04;
                        const item = new THREE.Mesh(new THREE.BoxGeometry(0.09, ih, 0.09), mat);
                        item.position.set(wx + side * 0.10, sy + 0.025 + ih / 2, sp - 0.38 + k * 0.38);
                        g.add(item);
                    });
                });
            });
        });

        // Warm focal light above the counter
        const counterGlow = new THREE.PointLight(0xffcc88, 2.2, 4.5 * WS, 0);
        counterGlow.position.set(0, floorY + 2.0, counterZ);
        g.add(counterGlow);

        return g;
    }

    // No-op under the contiguous floorplan (ADR 0012): the boss hall is a larger
    // *room footprint* in the plan, not a rescale of a single shared corridor box.
    function applyRoomScale(apply) { /* room dimensions are fixed plan geometry */ }

    function applyRoomTheme(nodeType, nodeId) {
        clearRoomProp();
        bossPerimTorches.forEach(l => { l.intensity = 0; });
        doorGlow.intensity = 2;
        if (nodeType === 'forced') {
            scene.fog.near = 9 * WS; scene.fog.far = 14 * WS;
            applyRoomScale(false);
            setRoomMats('forced');
            torch1.color.setHex(0xff8844); torch1.intensity = 2.2;
            torch2.color.setHex(0xff8844); torch2.intensity = 1.8;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x1d4ed8);
            roomProp = buildForcedProp();
            roomGroup.add(roomProp);
        } else if (nodeType === 'elite') {
            scene.fog.near = 9 * WS; scene.fog.far = 14 * WS;
            applyRoomScale(false);
            setRoomMats('elite');
            torch1.color.setHex(0xff1100); torch1.intensity = 2.2;
            torch2.color.setHex(0xdd0800); torch2.intensity = 1.8;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x660000);
            roomProp = buildEliteProp();
            roomGroup.add(roomProp);
        } else if (nodeType === 'boss') {
            scene.fog.near = 9 * WS; scene.fog.far = 14 * WS;
            const bossCleared = nodeId && getCleared().has(nodeId);
            applyRoomScale(true);
            setRoomMats('boss');
            const torchHex = bossCleared ? 0xdd4411 : 0xbb2200;
            const t1i = bossCleared ? 1.8 : 1.0, t2i = bossCleared ? 1.6 : 0.9;
            torch1.color.setHex(torchHex); torch1.intensity = t1i;
            torch2.color.setHex(torchHex); torch2.intensity = t2i;
            torch1.position.set(-5.5, CY - BH / 2 + 2.2, -2.5);
            torch2.position.set( 5.5, CY - BH / 2 + 2.2, -2.5);
            doorGlow.color.setHex(0x660000);
            roomProp = buildBossProp(bossCleared);
            roomGroup.add(roomProp);
        } else if (nodeType === 'treasure') {
            scene.fog.near = 9 * WS; scene.fog.far = 14 * WS;
            applyRoomScale(false);
            setRoomMats('treasure');
            torch1.color.setHex(0xffcc44); torch1.intensity = 2.4;
            torch2.color.setHex(0xffaa22); torch2.intensity = 2.0;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0xd4a017);
            roomProp = buildTreasureProp();
            roomGroup.add(roomProp);
        } else if (nodeType === 'rest') {
            scene.fog.near = 9 * WS; scene.fog.far = 14 * WS;
            applyRoomScale(false);
            setRoomMats('rest');
            // Torches dim to near-nothing — campfire carries the room
            torch1.color.setHex(0x1a0a04); torch1.intensity = 0;
            torch2.color.setHex(0x1a0a04); torch2.intensity = 0;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x6b3a10); doorGlow.intensity = 0.7;
            campfireLight = new THREE.PointLight(0xff5810, 2.6, 9 * WS, 0);
            campfireLight.position.set(0, CY - CH / 2 + 0.45, -3.2);
            roomGroup.add(campfireLight);
            roomProp = buildRestProp();
            roomGroup.add(roomProp);
        } else if (nodeType === 'mystery') {
            scene.fog.near = 5 * WS; scene.fog.far = 11 * WS;
            applyRoomScale(false);
            setRoomMats('mystery');
            torch1.color.setHex(0x6622cc); torch1.intensity = 0.22;
            torch2.color.setHex(0x5511aa); torch2.intensity = 0.16;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x8b5cf6);
            roomProp = buildMysteryProp();
            roomGroup.add(roomProp);
        } else if (nodeType === 'shop') {
            scene.fog.near = 9 * WS; scene.fog.far = 14 * WS;
            applyRoomScale(false);
            setRoomMats('shop');
            torch1.color.setHex(0xffaa44); torch1.intensity = 2.0;
            torch2.color.setHex(0xff8822); torch2.intensity = 1.7;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0xd4a017);
            roomProp = buildShopProp();
            roomGroup.add(roomProp);
        } else {
            scene.fog.near = 9 * WS; scene.fog.far = 14 * WS;
            applyRoomScale(false);
            setRoomMats('default');
            torch1.color.setHex(0xff6622); torch1.intensity = 2.2;
            torch2.color.setHex(0xff6622); torch2.intensity = 1.8;
            torch1.position.set(-1.6, 1.0, -2);
            torch2.position.set( 1.6, 1.0, -5);
            doorGlow.color.setHex(0x1d4ed8);
        }
        // Room props are rebuilt on every entry, so texture them here (not in the
        // one-shot floorplan pass). _dsApplyRealTex skips anything already mapped,
        // and clearRoomProp's traversal disposes these cloned materials next time.
        if (roomProp) _dsTextureAllSurfaces(THREE, roomProp);
        // Show the standing torch fires only in the standard corridor themes —
        // boss/rest/mystery carry their own fire dressing (perimeter stands,
        // campfire, ethereal altar) and reposition or kill the corridor torches.
        flamesVisible = !(nodeType === 'boss' || nodeType === 'rest' || nodeType === 'mystery');
    }

    // ── HTML overlay layers ───────────────────────────────────────────────────
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    container.appendChild(canvasWrap);
    canvasWrap.appendChild(canvas);

    const fadeEl = document.createElement('div');
    fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2;';
    canvasWrap.appendChild(fadeEl);

    const encounterEl = document.createElement('div');
    // Docked low with a soft vignette (not a hard full-screen modal) so the room
    // and the prop you walked up to stay visible behind the encounter — the panel
    // reads as surfacing *at the campfire / counter / plinth*, in-world.
    encounterEl.style.cssText = 'display:none;position:absolute;inset:0;background:radial-gradient(ellipse at 50% 38%, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.74) 78%);z-index:5;align-items:flex-end;justify-content:center;padding:0 16px 40px;overflow-y:auto;';
    canvasWrap.appendChild(encounterEl);

    const minimapCanvas = document.createElement('canvas');
    minimapCanvas.width = 640; minimapCanvas.height = 480;
    minimapCanvas.style.cssText = 'position:absolute;top:8px;right:8px;z-index:3;border:2px solid #2a2a2a;background:rgba(0,0,0,0.75);';
    canvasWrap.appendChild(minimapCanvas);


    // One-time controls hint (mouselook needs a click to engage Pointer Lock).
    const hintEl = document.createElement('div');
    hintEl.textContent = 'CLICK TO LOOK · WASD MOVE · WALK UP TO A PROP · E TO USE';
    hintEl.style.cssText = 'position:absolute;bottom:64px;left:50%;transform:translateX(-50%);color:#7a7a7a;font-family:monospace;font-size:0.7rem;letter-spacing:.18em;z-index:4;pointer-events:none;text-shadow:0 0 6px #000;transition:opacity .4s ease;';
    canvasWrap.appendChild(hintEl);
    function hideHint() { if (hintEl) { hintEl.style.opacity = '0'; } }

    // Transient feedback when the player bumps a sealed exit before clearing the
    // room. Flashed by moveStep/moveForward; fades ~1.6s after the last bump.
    const sealedEl = document.createElement('div');
    sealedEl.style.cssText = 'position:absolute;bottom:64px;left:50%;transform:translateX(-50%);color:#e8a04b;font-family:monospace;font-size:0.75rem;letter-spacing:.15em;z-index:5;pointer-events:none;text-shadow:0 0 8px #000;opacity:0;transition:opacity .3s ease;text-align:center;white-space:nowrap;';
    canvasWrap.appendChild(sealedEl);
    let _sealedTimer = null;
    function flashSealed() {
        const verb = INTERACT_VERB[nodeById(state.nodeId)?.type] || 'finish this room';
        sealedEl.textContent = `⛔ ${verb} TO UNSEAL THE PATHS`;
        sealedEl.style.opacity = '1';
        if (_sealedTimer) clearTimeout(_sealedTimer);
        _sealedTimer = setTimeout(() => { sealedEl.style.opacity = '0'; }, 1600);
    }

    const exitBtn = document.createElement('button');
    exitBtn.textContent = '☰ MENU';
    exitBtn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:6;background:#0a0a0a;border:1px solid #2a2a2a;color:#aaa;font-family:monospace;font-size:0.7rem;padding:4px 10px;cursor:pointer;letter-spacing:.15em;';
    exitBtn.onclick = () => _dsShowPauseMenu(d);
    canvasWrap.appendChild(exitBtn);

    const interactBtn = document.createElement('button');
    interactBtn.textContent = '! ENTER';
    interactBtn.style.cssText = 'display:none;position:absolute;bottom:8px;left:8px;z-index:6;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:0.8rem;padding:10px 14px;cursor:pointer;letter-spacing:.1em;touch-action:manipulation;border-radius:4px;';
    interactBtn.onclick = () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle' && promptArmed && promptNear) startFaceTween(state.nodeId); };
    canvasWrap.appendChild(interactBtn);

    const dunReticle = document.createElement('div');
    dunReticle.className = 'ds-reticle';
    canvasWrap.appendChild(dunReticle);

    // On-screen nav pad (bottom-right)
    const navPad = document.createElement('div');
    navPad.style.cssText = 'position:absolute;bottom:8px;right:8px;z-index:6;display:flex;flex-direction:column;align-items:center;gap:4px;';
    const btnFwd = document.createElement('button');
    btnFwd.innerHTML = '▲';
    btnFwd.style.cssText = 'width:96px;height:48px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#aaa;font-family:monospace;font-size:1.1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;';
    // Touch/no-mouse fallback: hold ▲ to walk forward (toward whatever you face).
    const _btnFwdHold = (v) => (ev) => { ev.preventDefault(); if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') qc.keys.f = v; };
    btnFwd.addEventListener('pointerdown', _btnFwdHold(true));
    btnFwd.addEventListener('pointerup', _btnFwdHold(false));
    btnFwd.addEventListener('pointerleave', _btnFwdHold(false));
    btnFwd.addEventListener('pointercancel', _btnFwdHold(false));
    const navRow = document.createElement('div');
    navRow.style.cssText = 'display:flex;gap:4px;';
    const btnLeft = document.createElement('button');
    btnLeft.innerHTML = '◀';
    btnLeft.style.cssText = 'width:44px;height:44px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#777;font-family:monospace;font-size:1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;';
    btnLeft.onclick = () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') qc.yaw += 0.35; };
    const btnRight = document.createElement('button');
    btnRight.innerHTML = '▶';
    btnRight.style.cssText = 'width:44px;height:44px;background:rgba(10,10,10,0.85);border:1px solid #3a3a3a;color:#777;font-family:monospace;font-size:1rem;cursor:pointer;touch-action:manipulation;border-radius:4px;';
    btnRight.onclick = () => { if (_dsAudio) _dsAudio.init(); if (state.phase === 'idle') qc.yaw -= 0.35; };
    navRow.appendChild(btnLeft);
    navRow.appendChild(btnRight);
    navPad.appendChild(btnFwd);
    navPad.appendChild(navRow);
    canvasWrap.appendChild(navPad);

    const hudEl = document.createElement('div');
    hudEl.style.cssText = 'height:44px;background:#060606;border-top:2px solid #181818;display:flex;align-items:center;padding:0 12px;font-family:monospace;font-size:0.75rem;color:#555;gap:8px;flex-shrink:0;';
    container.appendChild(hudEl);

    // ── Node door colors ──────────────────────────────────────────────────────
    const DOOR_COL = {
        forced:  [0x1d4ed8, 0x0a1840],
        elite:   [0xd97706, 0x5a2d00],
        boss:    [0x991b1b, 0x3a0808],
        rest:    [0x374151, 0x101820],
        shop:    [0x7c3aed, 0x2d0f6a],
        mystery: [0x8b5cf6, 0x2d1659],
        treasure:[0xb45309, 0x4a2000],
        choice:  [0x047857, 0x012a1c],
    };

    // ── Door destination signs ────────────────────────────────────────────────
    // Each exit shows the room type it leads to (icon + name) so the player knows
    // whether a door goes to a Rest, Treasure, Elite, etc. before committing.
    const DOOR_LABEL_NAME = {
        forced: 'SONG', elite: 'ELITE', boss: 'BOSS', rest: 'REST',
        shop: 'SHOP', mystery: 'MYSTERY', treasure: 'TREASURE', choice: 'CHOICE',
    };
    function makeDoorLabel(type) {
        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 96;
        const c = cv.getContext('2d');
        const icon = NODE_TYPE_ICONS[type] || '◇';
        const name = DOOR_LABEL_NAME[type] || (type || '???').toUpperCase();
        c.fillStyle = 'rgba(8,8,10,0.78)';
        c.fillRect(0, 0, 256, 96);
        c.lineWidth = 4;
        c.strokeStyle = 'rgba(0,0,0,0.55)';
        c.strokeRect(2, 2, 252, 92);
        c.textAlign = 'center';
        c.font = '44px serif';
        c.fillStyle = '#ffffff';
        c.fillText(icon, 128, 50);
        c.font = 'bold 24px monospace';
        c.fillStyle = '#e8c040';
        c.fillText(name, 128, 84);
        const tex = new THREE.CanvasTexture(cv);
        tex.minFilter = tex.magFilter = THREE.NearestFilter;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.5), mat);
        mesh.renderOrder = 18;
        return { mesh, tex, mat };
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    const nodeById = id => (map.nodes || []).find(n => n.id === id);
    const getCleared   = () => new Set(d.cleared_node_ids || []);
    const getAvailable = () => new Set(d.available_node_ids || []);
    // A room's exits stay sealed until its own encounter is resolved. Clearing a
    // node always rebuilds the dungeon (dsClearNode -> dsInit), so this reads the
    // fresh payload and is constant for the life of one room view.
    const currentCleared = () => getCleared().has(state.nodeId);

    // Saved position is now a coordinate (ADR 0012): resume where the player stood.
    function savePos() {
        try {
            localStorage.setItem('ds_dun_pos_' + d.date,
                JSON.stringify({ x: camera.position.x, z: camera.position.z, node: state.nodeId }));
        } catch (e) {}
    }

    // ── In-world interaction zones ────────────────────────────────────────────
    // Each room's signature prop is an *area you walk up to*. Standing within
    // INTERACT_RADIUS of the anchor lights a billboard prompt floating over the
    // prop and arms the Enter action; the encounter no longer auto-opens on room
    // arrival. Anchors are local coords (× WS for world space) matched to the
    // positions built in build*Prop() — campfire, counter, plinth, altar, dais.
    const INTERACT_ANCHOR = {
        // y is absolute world-local (the prompt renders at y + 0.45); each value
        // floats the box ~0.1 above that room's central prop. See the prop
        // builders for the geometry these track.
        forced:   { x: 0.0, z: -2.6, y: -0.10 },
        elite:    { x: 0.0, z: -2.8, y: -0.57 },
        boss:     { x: 0.0, z: -5.4, y: 0.90 },
        treasure: { x: 0.0, z: -6.5, y: -0.33 },
        rest:     { x: 0.0, z: -3.2, y: -0.42 },
        mystery:  { x: 0.0, z: -6.0, y: -0.10 },
        shop:     { x: 0.0, z: -6.2, y: 0.86 },
        choice:   { x: 0.0, z: -4.0, y: 0.90 },
        event:    { x: 0.0, z: -4.0, y: 0.90 },
    };
    const INTERACT_VERB = {
        forced: 'PLAY', elite: 'PLAY', boss: 'CHALLENGE', treasure: 'OPEN',
        rest: 'REST', mystery: 'INSPECT', shop: 'BROWSE', choice: 'CHOOSE', event: 'ENTER',
    };
    const INTERACT_RADIUS = 1.7 * WS;

    // Reusable billboard that floats above the current room's prop.
    const promptCanvas = document.createElement('canvas');
    promptCanvas.width = 256; promptCanvas.height = 128;
    const promptCtx = promptCanvas.getContext('2d');
    const promptTex = new THREE.CanvasTexture(promptCanvas);
    promptTex.minFilter = promptTex.magFilter = THREE.NearestFilter;
    const promptMat = new THREE.MeshBasicMaterial({ map: promptTex, transparent: true, depthTest: false, side: THREE.DoubleSide });
    const promptMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), promptMat);
    promptMesh.renderOrder = 20;
    promptMesh.visible = false;
    roomGroup.add(promptMesh);
    let promptAnchor = null;   // {x,y,z} local for the current node, or null
    let promptNear = false;    // player within INTERACT_RADIUS this frame
    let promptArmed = false;   // node is interactable (available or cleared)
    // Face-tween state for Skyrim-style camera turn on interact.
    let faceTween = 0;
    let faceStartYaw = 0;
    let faceTargetYaw = 0;
    let faceStartPitch = 0;
    let faceTargetPitch = 0;

    function drawPromptCanvas(near) {
        const c = promptCtx;
        c.clearRect(0, 0, 256, 128);
        const n = nodeById(state.nodeId);
        const icon = NODE_TYPE_ICONS[n?.type] || '◇';
        const verb = INTERACT_VERB[n?.type] || 'ENTER';
        c.fillStyle = `rgba(8,8,10,${near ? 0.80 : 0.40})`;
        c.fillRect(28, 16, 200, 96);
        c.lineWidth = 3;
        c.strokeStyle = near ? 'rgba(232,192,64,0.95)' : 'rgba(120,110,80,0.5)';
        c.strokeRect(28, 16, 200, 96);
        c.textAlign = 'center';
        c.font = '42px serif';
        c.fillText(icon, 128, 62);
        c.font = 'bold 20px monospace';
        c.fillStyle = near ? '#e8c040' : '#8a8060';
        c.fillText(near ? `▲ E · ${verb}` : verb, 128, 98);
        promptTex.needsUpdate = true;
    }

    function positionPrompt(nodeType) {
        const a = INTERACT_ANCHOR[nodeType];
        promptAnchor = a || null;
        promptNear = false;
        if (!a) { promptMesh.visible = false; return; }
        // Float just above the prop (not so high it leaves the ~64° vertical FOV
        // when the player is standing right at it).
        promptMesh.position.set(a.x, a.y + 0.45, a.z);
        promptMesh.visible = true;
        drawPromptCanvas(false);
    }

    function isInteractable() {
        // The room you're physically standing in is always inspectable — this
        // matches the legacy auto-open-on-arrival the FPS walk-up replaced.
        // Whether you can actually act (Play/Bank/Buy) is gated *inside* the
        // encounter by availability (canPlay etc. in the draw bodies), so a node
        // you've reached but not yet unlocked still opens and shows its state.
        // Gating the open itself on availability silently broke deeper nodes
        // (e.g. mystery) that are current-but-not-in-`available_node_ids`.
        return !!nodeById(state.nodeId);
    }

    function isNearProp() {
        if (!promptAnchor) return false;
        // promptAnchor is room-local; roomGroup sits at the occupied room's centre.
        const ax = (roomGroup.position.x + promptAnchor.x) * WS;
        const az = (roomGroup.position.z + promptAnchor.z) * WS;
        return Math.hypot(camera.position.x - ax, camera.position.z - az) <= INTERACT_RADIUS;
    }

    // ── Contiguous floorplan (ADR 0012) ───────────────────────────────────────
    // Lay every room at its grid position (col→X, row→−Z), connect them with
    // axis-aligned L-corridors, rasterize the walkable space into an occupancy
    // grid, and extract walls from that grid. Closed corridors (rooms not yet
    // reachable) are blocked by rubble gates that explode when the source room is
    // cleared. Built once in start(); walls + gates change only when a section
    // opens. Geometry is in world-local units (the world group scales × WS).

    // Backend is authoritative: a corridor A→B is open iff B is "discovered".
    function discoveredSet() {
        const s = new Set();
        (d.available_node_ids || []).forEach(id => s.add(id));
        (d.cleared_node_ids   || []).forEach(id => s.add(id));
        (d.committed_node_ids  || []).forEach(id => s.add(id));
        return s;
    }
    function corridorOpen(c) {
        const disc = discoveredSet();
        // Entrance corridors (antechamber → a row-0 room) open iff that entrance is
        // discovered — this is what enforces lane commitment spatially: committing
        // to one entrance locks the siblings, which then rock over.
        if (c.aId == null) return disc.has(c.bId);
        // Inter-room corridors: open once the target is discovered. The source
        // being cleared is what makes its targets available (backend), so this
        // encodes "a room's exits stay blocked until it is cleared".
        return disc.has(c.bId) && (disc.has(c.aId) || nodeById(c.aId)?.row === 0);
    }

    // Standard stone material for floor/ceil/walls of the plan (themed floor is
    // swapped per-occupied-room via setRoomMats; walls stay this base material).
    function _planMat(map_) { const m = new THREE.MeshLambertMaterial({ map: map_ }); _floorplanDisposables.push(m); return m; }

    function _roomExtents(node) {
        return node.type === 'boss' ? [BOSS_HW, BOSS_HD] : [ROOM_HW, ROOM_HD];
    }
    function roomCenter(node) {
        const cols = (map.nodes || []).map(n => n.col || 0);
        const colMid = (Math.min(...cols) + Math.max(...cols)) / 2;
        return { x: ((node.col || 0) - colMid) * CELL_X, z: -((node.row || 0)) * CELL_Z };
    }

    // Build the layout records (positions/extents/anchors) for every node.
    function computeLayout() {
        for (const node of (map.nodes || [])) {
            const c = roomCenter(node);
            const [hw, hd] = _roomExtents(node);
            const a = INTERACT_ANCHOR[node.type] || { x: 0, z: -hd * 0.5, y: -0.1 };
            rooms[node.id] = { node, x: c.x, z: c.z, hw, hd, anchor: { x: a.x, z: a.z } };
        }
        // Corridors: one per edge. Route as an L (forward from A's far wall, lateral
        // jog at the mid-row band, forward into B's near wall). Record the tiles it
        // occupies so the occupancy grid + rubble placement can use them.
        for (const node of (map.nodes || [])) {
            const A = rooms[node.id]; if (!A) continue;
            for (const tid of (node.edges || [])) {
                const B = rooms[tid]; if (!B) continue;
                const aFar = A.z - A.hd;        // A's forward (−Z) wall
                const bNear = B.z + B.hd;        // B's back (+Z) wall
                const midZ = (aFar + bNear) / 2;
                corridors.push({
                    aId: node.id, bId: tid,
                    ax: A.x, bx: B.x, aFar, bNear, midZ,
                    mouthX: A.x, mouthZ: aFar - 0.6,    // rubble sits just past A's exit
                    open: false, gate: null,
                });
            }
        }
        // Entrance corridors: an antechamber behind row 0, connected to each entry
        // room by a short gated corridor. Locked lanes rock over (commitment).
        const entries = Object.values(rooms).filter(r => (r.node.row || 0) === 0);
        if (entries.length) {
            const ax0 = Math.min(...entries.map(r => r.x - r.hw));
            const ax1 = Math.max(...entries.map(r => r.x + r.hw));
            const entryNear = Math.max(...entries.map(r => r.z + r.hd));
            const acFront = entryNear + 5;       // antechamber's −Z (front) edge
            antechamber = { x0: ax0, x1: ax1, z0: acFront, z1: acFront + CELL_Z * 0.45 };
            for (const e of entries) {
                corridors.push({
                    aId: null, bId: e.node.id,
                    ax: e.x, bx: e.x, aFar: acFront, bNear: e.z + e.hd, midZ: (acFront + e.z + e.hd) / 2,
                    mouthX: e.x, mouthZ: e.z + e.hd + 0.6,
                    open: false, gate: null,
                });
            }
        }
    }

    // Rasterize rooms + open corridors + the antechamber into the occupancy grid.
    function buildOccupancy() {
        const xs = [], zs = [];
        for (const id in rooms) { const r = rooms[id]; xs.push(r.x - r.hw, r.x + r.hw); zs.push(r.z - r.hd, r.z + r.hd); }
        if (antechamber) { xs.push(antechamber.x0, antechamber.x1); zs.push(antechamber.z0, antechamber.z1); }
        const pad = 4;
        const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
        const z0 = Math.min(...zs) - pad, z1 = Math.max(...zs) + pad;
        const nx = Math.ceil((x1 - x0) / TILE), nz = Math.ceil((z1 - z0) / TILE);
        const cells = new Uint8Array(nx * nz);
        occ = { x0, z0, nx, nz, cells };
        const mark = (xa, xb, za, zb) => {
            const ia = Math.max(0, Math.floor((Math.min(xa, xb) - x0) / TILE));
            const ib = Math.min(nx - 1, Math.floor((Math.max(xa, xb) - x0) / TILE));
            const ja = Math.max(0, Math.floor((Math.min(za, zb) - z0) / TILE));
            const jb = Math.min(nz - 1, Math.floor((Math.max(za, zb) - z0) / TILE));
            for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) cells[j * nx + i] = 1;
        };
        for (const id in rooms) { const r = rooms[id]; mark(r.x - r.hw, r.x + r.hw, r.z - r.hd, r.z + r.hd); }
        if (antechamber) mark(antechamber.x0, antechamber.x1, antechamber.z0, antechamber.z1);
        // Legs overlap their endpoints by OV so the occupancy connects cleanly to
        // rooms/antechamber despite tile rounding (otherwise a 1-tile wall seam can
        // wall off an open passage).
        const OV = COR_HW;
        for (const c of corridors) {
            if (!c.open) continue;
            mark(c.ax - COR_HW, c.ax + COR_HW, Math.min(c.aFar, c.midZ) - OV, Math.max(c.aFar, c.midZ) + OV); // leg from A
            mark(Math.min(c.ax, c.bx) - COR_HW - OV, Math.max(c.ax, c.bx) + COR_HW + OV, c.midZ - COR_HW, c.midZ + COR_HW); // lateral jog
            mark(c.bx - COR_HW, c.bx + COR_HW, Math.min(c.midZ, c.bNear) - OV, Math.max(c.midZ, c.bNear) + OV); // leg into B
        }
    }

    function tileWalkable(x, z) {
        if (!occ) return true;
        const i = Math.floor((x - occ.x0) / TILE), j = Math.floor((z - occ.z0) / TILE);
        if (i < 0 || j < 0 || i >= occ.nx || j >= occ.nz) return false;
        return occ.cells[j * occ.nx + i] === 1;
    }

    // Extract wall quads from the occupancy boundary into one merged geometry.
    function buildWalls() {
        if (wallMesh) { world.remove(wallMesh); wallMesh.geometry.dispose(); wallMesh = null; }
        if (!occ) return;
        const { x0, z0, nx, nz, cells } = occ;
        const pos = [], norm = [], uv = [];
        const H = CH;
        const pushQuad = (ax, az, bx, bz, nxv, nzv) => {
            // vertical wall quad from (ax,az) to (bx,bz), floor→ceil
            const y0 = FLOOR_Y, y1 = CEIL_Y;
            const len = Math.hypot(bx - ax, bz - az);
            const v = [ax, y0, az,  bx, y0, bz,  bx, y1, bz,  ax, y0, az,  bx, y1, bz,  ax, y1, az];
            for (let k = 0; k < 6; k++) norm.push(nxv, 0, nzv);
            pos.push(...v);
            uv.push(0, 0, len, 0, len, H, 0, 0, len, H, 0, H);
        };
        for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
            if (cells[j * nx + i]) continue; // only solid cells emit faces (toward walkable neighbours)
            const wx = x0 + i * TILE, wz = z0 + j * TILE;
            const walk = (ii, jj) => (ii >= 0 && jj >= 0 && ii < nx && jj < nz && cells[jj * nx + ii] === 1);
            if (walk(i - 1, j)) pushQuad(wx, wz, wx, wz + TILE, 1, 0);             // face +X (toward walkable on −X)
            if (walk(i + 1, j)) pushQuad(wx + TILE, wz + TILE, wx + TILE, wz, -1, 0);
            if (walk(i, j - 1)) pushQuad(wx + TILE, wz, wx, wz, 0, 1);
            if (walk(i, j + 1)) pushQuad(wx, wz + TILE, wx + TILE, wz + TILE, 0, -1);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        wallMesh = new THREE.Mesh(geo, wallMat);
        world.add(wallMesh);
    }

    // ── Rubble gates ──────────────────────────────────────────────────────────
    const _rockGeos = [
        new THREE.DodecahedronGeometry(0.55, 0),
        new THREE.DodecahedronGeometry(0.8, 0),
        new THREE.IcosahedronGeometry(0.7, 0),
        new THREE.BoxGeometry(0.9, 0.7, 0.8),
    ];
    _rockGeos.forEach(g => _floorplanDisposables.push(g));
    // One shared, real-textured rubble material. noAutoTex: we apply the stone
    // texture explicitly here, so the surface-texturing post-pass must skip it
    // (it would otherwise clone it per-mesh before the async map lands).
    const _rubbleMat = new THREE.MeshLambertMaterial({ color: 0x5a524a });
    _rubbleMat.userData.noAutoTex = true;
    _floorplanDisposables.push(_rubbleMat);
    _dsApplyRealTex(THREE, _rubbleMat, 'wall_stone.png', 1, 1, 0x5a524a);
    // A rubble pile is now ONE merged mesh per gate (was 11 separate rock meshes
    // → ~143 draw calls across the 13 sealed corridors at spawn). The 11 boulders
    // are baked into a single BufferGeometry (position/normal/uv carried through
    // so the stone texture still maps); detonateGate() spawns transient debris.
    const _rubbleTmp = { m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler(), s: new THREE.Vector3() };
    function makeRubble() {
        const span = COR_HW * 2 + 0.6, n = 11;
        const pos = [], norm = [], uv = [];
        for (let k = 0; k < n; k++) {
            const sc = 0.6 + Math.random() * 0.9;
            _rubbleTmp.p.set((Math.random() - 0.5) * span, FLOOR_Y + Math.random() * 1.6, (Math.random() - 0.5) * 1.6);
            _rubbleTmp.e.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
            _rubbleTmp.q.setFromEuler(_rubbleTmp.e);
            _rubbleTmp.s.setScalar(sc);
            _rubbleTmp.m.compose(_rubbleTmp.p, _rubbleTmp.q, _rubbleTmp.s);
            let g2 = _rockGeos[k % _rockGeos.length].clone();   // never mutate the shared base
            if (g2.index) { const t = g2.toNonIndexed(); g2.dispose(); g2 = t; }
            g2.applyMatrix4(_rubbleTmp.m);   // transforms position AND normal
            const P = g2.attributes.position.array, N = g2.attributes.normal.array;
            const U = g2.attributes.uv ? g2.attributes.uv.array : null;
            for (let i = 0; i < P.length; i++) pos.push(P[i]);
            for (let i = 0; i < N.length; i++) norm.push(N[i]);
            if (U) for (let i = 0; i < U.length; i++) uv.push(U[i]);
            else for (let i = 0, c = P.length / 3; i < c; i++) uv.push(0, 0);
            g2.dispose();
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        return new THREE.Mesh(geo, _rubbleMat);
    }
    // Place a rubble pile in each closed corridor's mouth; remove from open ones.
    function refreshGates() {
        for (const c of corridors) {
            const open = corridorOpen(c);
            c.open = open;
            if (open && c.gate) { roomGroup_removeGate(c); }
            else if (!open && !c.gate) {
                const g = makeRubble();
                g.position.set(c.mouthX, 0, c.mouthZ + 0.4);
                world.add(g);
                c.gate = g;
                rubbleGates.push({ corridor: c, group: g });
            }
        }
    }
    function roomGroup_removeGate(c) {
        if (!c.gate) return;
        world.remove(c.gate);
        c.gate.traverse(o => { if (o.isMesh && o.geometry && _rockGeos.indexOf(o.geometry) < 0) o.geometry.dispose(); });
        const idx = rubbleGates.findIndex(rg => rg.corridor === c);
        if (idx >= 0) rubbleGates.splice(idx, 1);
        c.gate = null;
    }

    // ── Explosion VFX ─────────────────────────────────────────────────────────
    // Detonate the rubble blocking a corridor: fling the boulders outward as
    // debris, spit sparks, flash a light, boom. Replaces ADR 0010's door-unseal.
    function detonateGate(c) {
        if (!c.gate) { c.open = true; return; }
        const gate = c.gate;
        const origin = gate.position.clone();
        const pieces = [];
        world.remove(gate);                    // detach the merged pile once
        if (gate.geometry) gate.geometry.dispose();   // its merged geo is transient
        // Spawn individual debris boulders to fling — shared _rockGeos + _rubbleMat
        // (so the explosion cleanup's dispose-guard leaves them alone).
        const span = COR_HW * 2 + 0.6;
        for (let i = 0; i < 11; i++) {
            const rock = new THREE.Mesh(_rockGeos[i % _rockGeos.length], _rubbleMat);
            rock.scale.setScalar(0.6 + Math.random() * 0.9);
            rock.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
            rock.position.set(
                origin.x + (Math.random() - 0.5) * span,
                origin.y + FLOOR_Y + Math.random() * 1.6,
                origin.z + (Math.random() - 0.5) * 1.6,
            );
            world.add(rock);
            pieces.push({
                mesh: rock,
                vx: (Math.random() - 0.5) * 26,
                vy: 6 + Math.random() * 16,
                vz: (Math.random() - 0.5) * 26,
                spin: new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12),
            });
        }
        // Spark burst (additive points).
        const sn = 40, sp = new Float32Array(sn * 3), sv = [];
        for (let i = 0; i < sn; i++) {
            sp[i*3] = origin.x; sp[i*3+1] = origin.y + 0.8; sp[i*3+2] = origin.z;
            sv.push({ x: (Math.random()-0.5)*34, y: 4 + Math.random()*22, z: (Math.random()-0.5)*34 });
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
        const sm = new THREE.PointsMaterial({ color: 0xffb347, size: 3.2, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
        const sparks = new THREE.Points(sg, sm);
        world.add(sparks);
        // Flash light.
        const flash = new THREE.PointLight(0xffd28a, 6, 9 * WS, 0);
        flash.position.copy(origin).setY(origin.y + 1);
        world.add(flash);
        explosions.push({ pieces, sparks, sparkVel: sv, flash, t: 0, dur: 1.5 });
        const idx = rubbleGates.findIndex(rg => rg.corridor === c);
        if (idx >= 0) rubbleGates.splice(idx, 1);
        c.gate = null;
        c.open = true;
        if (_dsAudio && _dsAudio.playBoom) _dsAudio.playBoom();
        else if (_dsAudio && _dsAudio.playDoorOpen) _dsAudio.playDoorOpen();
        // Camera kick: scale by proximity (origin is world-local, camera is in
        // world units → divide by WS to compare). Near blasts shake hard, far
        // ones barely. Take the max so simultaneous gates don't stack to nausea.
        const pd = Math.hypot(origin.x - camera.position.x / WS, origin.z - camera.position.z / WS);
        camShake = Math.max(camShake, 0.018 + 0.045 * Math.max(0, 1 - pd / 14));
    }

    function tickExplosions(dt) {
        for (let e = explosions.length - 1; e >= 0; e--) {
            const ex = explosions[e];
            ex.t += dt;
            const k = ex.t / ex.dur;
            ex.pieces.forEach(p => {
                p.vy -= 38 * dt;          // gravity
                p.mesh.position.x += p.vx * dt;
                p.mesh.position.y += p.vy * dt;
                p.mesh.position.z += p.vz * dt;
                if (p.mesh.position.y < FLOOR_Y + 0.2) { p.mesh.position.y = FLOOR_Y + 0.2; p.vy *= -0.3; p.vx *= 0.6; p.vz *= 0.6; }
                p.mesh.rotation.x += p.spin.x * dt; p.mesh.rotation.y += p.spin.y * dt; p.mesh.rotation.z += p.spin.z * dt;
            });
            const arr = ex.sparks.geometry.attributes.position.array;
            ex.sparkVel.forEach((v, i) => { v.y -= 30 * dt; arr[i*3] += v.x*dt; arr[i*3+1] += v.y*dt; arr[i*3+2] += v.z*dt; });
            ex.sparks.geometry.attributes.position.needsUpdate = true;
            ex.sparks.material.opacity = Math.max(0, 1 - k * 1.4);
            if (ex.flash) ex.flash.intensity = Math.max(0, 6 * (1 - k * 2.2));
            if (k >= 1) {
                ex.pieces.forEach(p => { world.remove(p.mesh); if (_rockGeos.indexOf(p.mesh.geometry) < 0) p.mesh.geometry.dispose(); });
                world.remove(ex.sparks); ex.sparks.geometry.dispose(); ex.sparks.material.dispose();
                if (ex.flash) world.remove(ex.flash);
                explosions.splice(e, 1);
            }
        }
    }

    // Build the entire plan: layout, occupancy, floor/ceil planes, walls, gates.
    function buildFloorplan() {
        computeLayout();
        corridors.forEach(c => { c.open = corridorOpen(c); });  // open states BEFORE rasterizing
        buildOccupancy();
        // Big spanning floor + ceiling (cheap; fog + walls bound what is seen).
        const fw = (occ.nx + 2) * TILE, fd = (occ.nz + 2) * TILE;
        const cx = occ.x0 + occ.nx * TILE / 2, cz = occ.z0 + occ.nz * TILE / 2;
        const floorGeo = new THREE.PlaneGeometry(fw, fd);
        const ceilGeo = new THREE.PlaneGeometry(fw, fd);
        _floorplanDisposables.push(floorGeo, ceilGeo);
        roomMeshes.floor = new THREE.Mesh(floorGeo, floorMat);
        roomMeshes.floor.rotation.x = -Math.PI / 2; roomMeshes.floor.position.set(cx, FLOOR_Y, cz);
        world.add(roomMeshes.floor);
        roomMeshes.ceil = new THREE.Mesh(ceilGeo, ceilMat);
        roomMeshes.ceil.rotation.x = Math.PI / 2; roomMeshes.ceil.position.set(cx, CEIL_Y, cz);
        world.add(roomMeshes.ceil);
        // Real floor/ceil textures sized to the spanning plane (~one tile / 2 units),
        // applied here (not at material creation) because the plane size is known now.
        const _ruF = Math.max(2, Math.round(fw / 2)), _rvF = Math.max(2, Math.round(fd / 2));
        _dsApplyRealTex(THREE, floorMat, 'floor_granite.png', _ruF, _rvF, null);
        _dsApplyRealTex(THREE, ceilMat,  'floor_plate.png',   _ruF, _rvF, null);
        buildWalls();
        refreshGates();
    }

    // Recompute gate/occupancy state after the payload's cleared/available sets
    // change, detonating any corridors that just opened. `justClearedId` (optional)
    // scopes the explosion to that room's exits so only the relevant rocks blow.
    function syncSections(justClearedId) {
        const toOpen = corridors.filter(c => !c.open && corridorOpen(c));
        const toClose = corridors.filter(c => c.open && !corridorOpen(c));
        let exploded = false;
        for (const c of toOpen) {
            if (!justClearedId || c.aId === justClearedId) { detonateGate(c); exploded = true; }
            else c.open = true; // opened off-screen (e.g. on load); no boom
        }
        for (const c of toClose) { c.open = false; } // sibling lanes seal silently
        // Rebuild occupancy + walls so the newly-open passages are walkable and the
        // sealed ones are walled. Drop rubble on any freshly-closed corridors.
        buildOccupancy();
        buildWalls();
        refreshGates();
        return exploded;
    }

    // Per-room ambient tint by current node type — gives each room a distinct
    // mood so consecutive rooms don't feel identical.
    const TYPE_TINT = {
        forced:   0x2a1a10, elite:    0x2a0808, boss:     0x300a0a,
        rest:     0x201810, shop:     0x281840, mystery:  0x180c2a,
        treasure: 0x382810, choice:   0x102a1c,
    };
    function applyRoomTint(nodeType) {
        const tint = TYPE_TINT[nodeType] || 0x221109;
        ambientLight.color.setHex(tint);
        // Tint the fog to a darkened version of the room mood instead of pure
        // black: distant corridor geometry recedes into a dim coloured haze
        // (readable depth + reinforced mood) rather than vanishing into a void,
        // while staying dark enough to keep hiding the rest of the map.
        scene.fog.color.setHex(tint).multiplyScalar(0.5);
    }

    // ── Quake-style first-person controls (ADR 0010) over the contiguous plan ──
    // Pointer-Lock mouselook + WASD Quake ground physics. Collision is now against
    // the occupancy grid (ADR 0012): the player walks the whole dungeon freely;
    // closed corridors are walled off by rubble until their source room is cleared.
    const qc = _dsQuakeController(camera, { eye: EYE });
    let pointerLocked = false;
    let _blockedThisFrame = false;

    function resetView() { qc.reset(); }

    // Walkability with the player's radius: centre + 4 cardinal probes must all be
    // on a walkable tile. Camera coords are × WS; the grid is in world-local units.
    function canStand(wx, wz) {
        const x = wx / WS, z = wz / WS, r = PLAYER_R;
        return tileWalkable(x, z) && tileWalkable(x + r, z) && tileWalkable(x - r, z)
            && tileWalkable(x, z + r) && tileWalkable(x, z - r);
    }

    // Which room rectangle contains a world point (or null if in a corridor).
    function roomAt(wx, wz) {
        const x = wx / WS, z = wz / WS;
        for (const id in rooms) {
            const r = rooms[id];
            if (x >= r.x - r.hw && x <= r.x + r.hw && z >= r.z - r.hd && z <= r.z + r.hd) return id;
        }
        return null;
    }

    function nearestClosedGate(wx, wz) {
        let best = Infinity;
        for (const c of corridors) {
            if (c.open) continue;
            best = Math.min(best, Math.hypot(wx / WS - c.mouthX, wz / WS - c.mouthZ));
        }
        return best;
    }

    // One Quake ground-move step with separated-axis collision against the plan.
    function moveStep(dt) {
        const w = qc.wishDir();
        qc.accelerate(dt, w.wx, w.wz, w.wishspeed);
        const nx = camera.position.x + qc.vel.x * dt;
        const nz = camera.position.z + qc.vel.z * dt;
        _blockedThisFrame = false;
        const wishing = Math.abs(qc.vel.x) + Math.abs(qc.vel.z) > 1;
        if (canStand(nx, camera.position.z)) camera.position.x = nx;
        else { qc.vel.x = 0; _blockedThisFrame = wishing; }
        if (canStand(camera.position.x, nz)) camera.position.z = nz;
        else { qc.vel.z = 0; _blockedThisFrame = wishing; }
        // Bumping a wall next to a still-rocked passage explains why it won't open.
        if (_blockedThisFrame && nearestClosedGate(camera.position.x, camera.position.z) < 2.6) flashSealed();
        camera.position.y = EYE + qc.viewBobRoll(dt);

        // The room we're standing in drives theme / light / motif / commit.
        const here = roomAt(camera.position.x, camera.position.z);
        if (here && here !== state.nodeId) enterRoom(here);
    }

    // ── Occupy a room ─────────────────────────────────────────────────────────
    // No teardown: reposition the dressing group to this room's centre, re-theme
    // lights + prop + motif, and commit the lane if this is a fresh available pick.
    function enterRoom(nodeId) {
        state.nodeId = nodeId;
        const n = nodeById(nodeId);
        const r = rooms[nodeId];
        if (r) roomGroup.position.set(r.x, 0, r.z);
        applyRoomTint(n?.type);
        applyRoomTheme(n?.type, nodeId);
        positionPrompt(n?.type);
        if (_dsAudio) _dsAudio.setRoomMotif(n?.type);
        maybeCommit(nodeId);
        updateSelection();
        savePos();
    }
    const enterNode = enterRoom;   // legacy alias

    // POST a lane commitment the first time the player physically steps into an
    // available, uncommitted room; refresh sections from the response (sibling
    // lanes that just locked drop rubble).
    let _committing = false;
    function maybeCommit(nodeId) {
        const avail = new Set(d.available_node_ids || []);
        const committed = new Set(d.committed_node_ids || []);
        const cleared = new Set(d.cleared_node_ids || []);
        if (_committing || committed.has(nodeId) || cleared.has(nodeId) || !avail.has(nodeId)) return;
        // Only commit when the player is *physically* inside the room — not when
        // enterRoom runs to preview a room's dressing from the antechamber.
        if (roomAt(camera.position.x, camera.position.z) !== nodeId) return;
        _committing = true;
        fetch('/api/plugins/the_daily/mark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                install_id: dsInstallId(), node_id: nodeId, action: 'commit',
                debug_no_save: !!d.debug_no_save,
                cleared_node_ids: d.cleared_node_ids || [],
                committed_node_ids: d.committed_node_ids || [],
            }),
        }).then(r => r.text()).then(t => {
            _committing = false;
            const res = t ? JSON.parse(t) : {};
            ['cleared_node_ids', 'available_node_ids', 'locked_node_ids', 'committed_node_ids'].forEach(k => {
                if (res[k]) d[k] = res[k];
            });
            syncSections();
            updateSelection();
        }).catch(() => { _committing = false; });
    }

    // ── HUD / affordance refresh (no doors any more) ──────────────────────────
    function updateSelection() {
        promptArmed = isInteractable();
        if (!promptArmed) { interactBtn.style.display = 'none'; promptNear = false; }
        btnFwd.style.opacity = '1';
        btnLeft.style.opacity = '1';
        btnRight.style.opacity = '1';
        updateHUD();
        drawMinimap();
    }

    // Clear the room the player is standing in *in place*: merge the fresh
    // server-recomputed state into the payload, close any open encounter, and
    // detonate the rubble blocking this room's exits (ADR 0012). Returns false if
    // the cleared node isn't the current room (caller does a full rebuild).
    function clearCurrentRoom(nodeId, newState) {
        if (!newState || nodeId !== state.nodeId) return false;
        ['cleared_node_ids', 'available_node_ids', 'locked_node_ids', 'committed_node_ids'].forEach(k => {
            if (newState[k]) d[k] = newState[k];
        });
        if (typeof newState.boss_revealed !== 'undefined') d.boss_revealed = newState.boss_revealed;
        if (newState.inventory) d.inventory = newState.inventory;
        if (typeof newState.is_complete !== 'undefined') d.is_complete = newState.is_complete;
        if (newState.progress) d.progress = newState.progress;
        if (encActive || state.phase === 'encounter') window._dsDungeonDismiss();
        syncSections(nodeId);
        applyRoomTheme(nodeById(nodeId)?.type, nodeId);  // refresh cleared-room dressing
        updateSelection();
        savePos();
        return true;
    }

    function updateHUD() {
        const mod = d.modifier || {};
        const cl = getCleared();
        const songTypes = ['forced', 'elite', 'boss'];
        const total = map.nodes.filter(n => songTypes.includes(n.type)).length;
        const done  = map.nodes.filter(n => cl.has(n.id) && songTypes.includes(n.type)).length;
        const pips  = Array.from({length: total}, (_, i) =>
            `<span style="color:${i < done ? '#ffd700' : '#333'}">●</span>`).join(' ');
        const tokens = d.inventory?.tokens ?? 0;
        hudEl.innerHTML = `
            <span style="flex:1;color:#3a78c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.day_name)}</span>
            <span style="color:#444;">${esc(mod.label || '')}</span>
            <span style="margin-left:auto;letter-spacing:3px;">${pips}</span>
            <span style="color:#666;margin-left:12px;">🪙${tokens}</span>
        `;
    }

    function drawMinimap() {
        const mctx = minimapCanvas.getContext('2d');
        const MW = minimapCanvas.width, MH = minimapCanvas.height;
        mctx.clearRect(0, 0, MW, MH);
        mctx.fillStyle = 'rgba(0,0,0,0.8)';
        mctx.fillRect(0, 0, MW, MH);

        const nodes = map.nodes || [];
        if (!nodes.length) return;

        const rs = nodes.map(n => n.row || 0), cs = nodes.map(n => n.col || 0);
        const minR = Math.min(...rs), maxR = Math.max(...rs);
        const minC = Math.min(...cs), maxC = Math.max(...cs);
        const pad = 28;
        const nx = n => pad + ((n.col||0) - minC) / Math.max(1, maxC - minC) * (MW - pad*2);
        const ny = n => pad + ((n.row||0) - minR) / Math.max(1, maxR - minR) * (MH - pad*2);

        const cl = getCleared(), av = getAvailable();

        // Edges colored by whether their corridor is actually walkable: open
        // (rock-gate blown) reads amber, sealed reads dim red — so the map answers
        // "which way can I go from here?" at a glance, not just the topology.
        const corridorFor = (aId, bId) => (corridors || []).find(c =>
            (c.aId === aId && c.bId === bId) || (c.aId === bId && c.bId === aId));
        nodes.forEach(n => (n.edges || []).forEach(tid => {
            const t = nodeById(tid);
            if (!t) return;
            const cor = corridorFor(n.id, tid);
            const open = cor ? cor.open : (cl.has(n.id) || cl.has(tid));
            mctx.strokeStyle = open ? 'rgba(232,176,90,0.85)' : 'rgba(150,60,55,0.45)';
            mctx.lineWidth = open ? 6.4 : 4;
            mctx.beginPath(); mctx.moveTo(nx(n), ny(n)); mctx.lineTo(nx(t), ny(t)); mctx.stroke();
            // Sealed-edge marker
            if (!open) {
                mctx.font = '22px monospace';
                mctx.fillStyle = 'rgba(150,60,55,0.65)';
                mctx.textAlign = 'center';
                mctx.textBaseline = 'middle';
                mctx.fillText('⊗', (nx(n) + nx(t)) / 2, (ny(n) + ny(t)) / 2);
            }
        }));

        // Current-room inbound highlight — brightens the reachable edges from
        // the player's standing node so "where can I go from here?" answers
        // itself without scanning all amber lines.
        const curN = nodeById(state.nodeId);
        if (curN) {
            (curN.edges || []).forEach(tid => {
                const t = nodeById(tid);
                if (!t) return;
                const cor = corridorFor(curN.id, tid);
                const open = cor ? cor.open : (cl.has(curN.id) || cl.has(tid));
                if (open) {
                    mctx.strokeStyle = 'rgba(255,210,120,0.55)';
                    mctx.lineWidth = 10;
                    mctx.beginPath(); mctx.moveTo(nx(curN), ny(curN)); mctx.lineTo(nx(t), ny(t)); mctx.stroke();
                }
            });
        }

        nodes.forEach(n => {
            const x = nx(n), y = ny(n), isCur = n.id === state.nodeId;
            const isBoss = n.type === 'boss';
            const r = isCur ? 20 : isBoss ? 18 : 12;
            const known = isCur || cl.has(n.id) || av.has(n.id);
            // Hue = room type; opacity = discovery state (undiscovered rooms dim).
            mctx.globalAlpha = known ? 1 : 0.34;
            mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2);
            mctx.fillStyle = _dsMapNodeColor(n.type);
            mctx.fill();
            mctx.globalAlpha = 1;
            if (isCur) {                       // current room: pulsing white ring
                const pulse = state.phase === 'idle' ? 0.55 + 0.45 * Math.sin(performance.now() * 0.004) : 1;
                mctx.strokeStyle = `rgba(255,255,255,${pulse.toFixed(2)})`; mctx.lineWidth = 6; mctx.stroke();
            } else if (cl.has(n.id)) {         // cleared: green tick ring
                mctx.strokeStyle = '#15803d'; mctx.lineWidth = 6; mctx.stroke();
            } else if (av.has(n.id)) {         // available next step: faint white ring
                mctx.strokeStyle = 'rgba(255,255,255,0.7)'; mctx.lineWidth = 4; mctx.stroke();
            }
            if (isBoss) {                      // boss always gets a red outline landmark
                mctx.strokeStyle = '#e0484c'; mctx.lineWidth = 6;
                mctx.beginPath(); mctx.arc(x, y, r + 8, 0, Math.PI * 2); mctx.stroke();
            }

            // Node type label — abbreviation on discovered nodes, '?' on undiscovered
            {
                const abbr = known
                    ? ({boss:'B',elite:'E',shop:'$',rest:'R',treasure:'T',mystery:'?',choice:'C',event:'V',forced:'F',song:'S'})[n.type] || '?'
                    : '?';
                mctx.font = '18px monospace';
                mctx.fillStyle = isCur ? '#000' : known ? '#ddd' : 'rgba(255,255,255,0.34)';
                mctx.textAlign = 'center';
                mctx.textBaseline = 'middle';
                mctx.fillText(abbr, x, y);
            }
        });

        // Live player marker (ADR 0012): geometry now matches the DAG, so the
        // player's world position maps straight onto the minimap's col/row space.
        if (occ) {
            const cols = nodes.map(n => n.col || 0);
            const colMid = (Math.min(...cols) + Math.max(...cols)) / 2;
            const pcol = camera.position.x / WS / CELL_X + colMid;
            const prow = -camera.position.z / WS / CELL_Z;
            const px = nx({ col: pcol }), py = ny({ row: prow });
            mctx.save();
            mctx.translate(px, py);
            mctx.rotate(-qc.yaw);
            mctx.shadowColor = 'rgba(255,255,255,0.6)';
            mctx.shadowBlur = 24;
            mctx.fillStyle = '#ffffff';
            mctx.beginPath(); mctx.moveTo(0, 20); mctx.lineTo(16, -16); mctx.lineTo(-16, -16); mctx.closePath(); mctx.fill();
            mctx.shadowColor = 'transparent';
            mctx.shadowBlur = 0;
            mctx.restore();
        }
    }

    // ── Diegetic encounter surface ────────────────────────────────────────────
    // Song nodes render their encounter *in the world* on a canvas-textured plane
    // that materialises in front of the player at the prop, rather than as a DOM
    // overlay. Buttons are hit-tested with a raycaster against the surface UV —
    // the same technique the WoF / Shop / Archive rooms use. Rest / treasure / shop
    // are multi-option, async, stateful flows and still use the docked DOM panel.
    const DIEGETIC_TYPES = new Set(['forced', 'elite', 'boss', 'choice', 'mystery', 'rest', 'treasure', 'shop']);
    const encRaycaster = new THREE.Raycaster();
    const encMouse = new THREE.Vector2();
    // Layout is authored in a 512×320 coordinate space, but the backing canvas is
    // supersampled (× ENC_SS) and the texture uses LinearFilter so small text stays
    // legible when the surface is drawn large on high-DPI displays (NearestFilter +
    // a 512-wide canvas turned fine text into an unreadable pixel mush).
    const ENC_W = 512, ENC_H = 320, ENC_SS = 3;
    const encCanvas = document.createElement('canvas');
    encCanvas.width = ENC_W * ENC_SS; encCanvas.height = ENC_H * ENC_SS;
    const encCtx = encCanvas.getContext('2d');
    const encTex = new THREE.CanvasTexture(encCanvas);
    encTex.minFilter = encTex.magFilter = THREE.LinearFilter;
    encTex.generateMipmaps = false;
    const encMat = new THREE.MeshBasicMaterial({ map: encTex, transparent: true, depthTest: false, side: THREE.DoubleSide });
    const encMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.625), encMat);
    encMesh.renderOrder = 30;
    encMesh.visible = false;
    world.add(encMesh);
    let encHits = [];        // [{x1,y1,x2,y2, action}] in UV space
    let encActive = false;   // diegetic encounter currently showing
    let encNodeId = null;
    let encData = null;  // async payload for rest/treasure: null=loading, {…}|{error}

    const _encRect = (px, py, w, h, action) =>
        ({ x1: px / ENC_W, x2: (px + w) / ENC_W, y1: 1 - (py + h) / ENC_H, y2: 1 - py / ENC_H, action });
    const _encTrim = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    // Width-aware trim: shrink to fit `maxPx` using the ctx's current font,
    // appending an ellipsis only when something was actually dropped. Use this
    // instead of a fixed char count when horizontal room is known, so strings
    // fill the available width rather than being clipped at a conservative guess.
    const _encTrimW = (ctx, s, maxPx) => {
        s = String(s == null ? '' : s);
        if (ctx.measureText(s).width <= maxPx) return s;
        let lo = 0, hi = s.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (ctx.measureText(s.slice(0, mid) + '…').width <= maxPx) lo = mid; else hi = mid - 1;
        }
        return s.slice(0, lo) + '…';
    };

    function _encSongOptions(node) {
        const songMap = Object.fromEntries((d.songs || []).map(s => [s.cf_id, s]));
        if (node.type === 'choice') return (node.cf_ids || []).map((id, i) => ({ label: `Option ${i + 1}`, song: songMap[id] }));
        if (node.type === 'mystery') {
            const pool = node.cf_pool || [];
            const idx = dsStableIndex(`${dsInstallId()}:${d.date}:${node.id}`, pool.length);
            return [{ label: 'Mystery revealed', song: songMap[pool[idx]] }];
        }
        if (node.type === 'boss') return [{ label: 'Boss', song: songMap[node.cf_id], boss: true }];
        return [{ label: 'Song', song: songMap[node.cf_id] }];
    }

    function drawEncounterCanvas() {
        const ctx = encCtx, W = ENC_W, H = ENC_H;
        ctx.setTransform(ENC_SS, 0, 0, ENC_SS, 0, 0);  // draw in 512×320 space, render supersampled
        ctx.clearRect(0, 0, W, H);
        encHits = [];
        const node = nodeById(encNodeId);
        if (!node) return;
        const [col] = DOOR_COL[node.type] || [0x1d4ed8];
        const border = '#' + col.toString(16).padStart(6, '0');
        ctx.fillStyle = 'rgba(6,7,10,0.93)';
        ctx.fillRect(8, 8, W - 16, H - 16);
        ctx.lineWidth = 5; ctx.strokeStyle = border;
        ctx.strokeRect(8, 8, W - 16, H - 16);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = '28px serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(NODE_TYPE_ICONS[node.type] || '◇', 26, 52);
        ctx.font = 'bold 20px monospace'; ctx.fillStyle = '#9aa4b2';
        ctx.fillText((node.type || '').toUpperCase(), 66, 49);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(26, 66); ctx.lineTo(W - 26, 66); ctx.stroke();

        if (node.type === 'rest') _encDrawRestBody(ctx, node);
        else if (node.type === 'treasure') _encDrawTreasureBody(ctx, node);
        else if (node.type === 'shop') _encDrawShopBody(ctx, node);
        else _encDrawSongBody(ctx, node);
        encTex.needsUpdate = true;
    }

    function _encWrapText(ctx, text, x, y, maxW, lineH, maxLines) {
        const words = String(text == null ? '' : text).split(/\s+/);
        let line = '', yy = y, used = 1;
        for (const w of words) {
            const test = line ? line + ' ' + w : w;
            if (ctx.measureText(test).width > maxW && line) {
                if (used >= maxLines) { ctx.fillText(line + '…', x, yy); return; }
                ctx.fillText(line, x, yy); yy += lineH; line = w; used++;
            } else line = test;
        }
        if (line) ctx.fillText(line, x, yy);
    }

    function _encDrawLeaveButton(ctx, label, action) {
        const W = ENC_W, H = ENC_H;
        const cbw = 168, cbh = 38, cbx = (W - cbw) / 2, cby = H - cbh - 16;
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(cbx, cby, cbw, cbh);
        ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 2; ctx.strokeRect(cbx, cby, cbw, cbh);
        ctx.fillStyle = '#c2cad6'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
        ctx.fillText(label, W / 2, cby + cbh / 2 + 5); ctx.textAlign = 'left';
        encHits.push(_encRect(cbx, cby, cbw, cbh, action));
    }

    function _encDrawRestBody(ctx, node) {
        const W = ENC_W, H = ENC_H;
        ctx.fillStyle = '#7fd6a0'; ctx.font = 'bold 14px monospace';
        ctx.fillText('LINER NOTES', 38, 98);
        const data = encData;
        const isErr = !!(data && data.error);
        const notes = data == null ? 'Resting…' : isErr ? 'Failed to load rest node.' : (data.notes || 'No notes available.');
        ctx.fillStyle = isErr ? '#f87171' : '#d4dce8'; ctx.font = '16px monospace';
        _encWrapText(ctx, notes, 38, 126, W - 76, 23, 4);
        const canAct = data != null && !isErr;
        const bw = 210, bh = 44, bx = (W - bw) / 2, by1 = H - bh * 2 - 30;
        ctx.fillStyle = canAct ? '#2e7d4f' : '#243a30'; ctx.fillRect(bx, by1, bw, bh);
        ctx.fillStyle = canAct ? '#fff' : '#566'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
        ctx.fillText('💰 BANK PROGRESS', W / 2, by1 + bh / 2 + 5); ctx.textAlign = 'left';
        if (canAct) encHits.push(_encRect(bx, by1, bw, bh, () => dsBankProgress(node.id)));
        _encDrawLeaveButton(ctx, '🏃 SKIP', () => dsClearNode(node.id));
    }

    const _encTitleCase = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Render any scalar/object/array value to readable text — never "[object Object]".
    function _encScalar(v) {
        if (v == null) return '';
        if (Array.isArray(v)) return v.map(_encScalar).filter(Boolean).join(', ');
        if (typeof v === 'object') {
            if (v.title || v.artist) return [v.title, v.artist].filter(Boolean).join(' — ');
            return Object.values(v).map(_encScalar).filter(Boolean).join(' ');
        }
        return String(v);
    }

    // Treasure peeks all share the {type, ...} shape but differ in payload; format
    // each into a one-line human summary. Generic fallback skips the redundant
    // `type` key and stringifies nested values safely.
    function _encFormatPeek(payload) {
        if (payload == null) return 'Reward claimed.';
        if (typeof payload === 'string') return payload;
        if (typeof payload !== 'object') return String(payload);
        const songStr = s => [s && s.title, s && s.artist].filter(Boolean).join(' — ') || 'Unknown song';
        switch (payload.type) {
            case 'boss_song': {
                const s = payload.song || {};
                return `Boss: ${songStr(s)}${s.tuning ? ` (${s.tuning})` : ''}`;
            }
            case 'tomorrow_modifier':
                return `Tomorrow: ${[payload.modifier_icon, payload.modifier_label].filter(Boolean).join(' ')}` +
                       (payload.day_name ? ` — "${payload.day_name}"` : '');
            case 'tomorrow_lanes': {
                const lanes = Object.values(payload.lanes || {});
                return lanes.length ? `Tomorrow's lanes: ${lanes.join(', ')}` : 'No lane data.';
            }
            case 'next_two_days': {
                const days = (payload.days || []).map(d => `${d.date}: ${d.day_name}`);
                return days.length ? days.join('   ·   ') : 'No upcoming data.';
            }
            case 'pool_glimpse': {
                const songs = (payload.songs || []).map(songStr);
                return songs.length ? songs.join(',  ') : 'No songs.';
            }
            case 'mystery_event':
                return payload.hint || 'A special event awaits.';
            default:
                return Object.entries(payload)
                    .filter(([k]) => k !== 'type')
                    .map(([k, v]) => `${k}: ${_encScalar(v)}`)
                    .join('   ·   ') || 'Reward claimed.';
        }
    }

    function _encDrawTreasureBody(ctx, node) {
        const W = ENC_W;
        const data = encData;
        if (data == null) {
            ctx.fillStyle = '#d4dce8'; ctx.font = '16px monospace';
            ctx.fillText('Examining the hoard…', 38, 126);
            return;
        }
        if (data.error) {
            ctx.fillStyle = '#f87171'; ctx.font = '16px monospace';
            ctx.fillText('Failed to load treasure.', 38, 126);
            _encDrawLeaveButton(ctx, '✕ LEAVE', () => window._dsDungeonDismiss());
            return;
        }
        if (data.chosen) {
            ctx.fillStyle = '#f0c14b'; ctx.font = 'bold 14px monospace';
            ctx.fillText('CLAIMED', 38, 98);
            const chosenLabel = (data.options || []).find(o => o.type === data.chosen)?.label
                || _encTitleCase(data.chosen);
            ctx.fillStyle = '#fff'; ctx.font = 'bold 23px monospace';
            ctx.fillText(_encTrim(String(chosenLabel), 28), 38, 130);
            let summary = '';
            try { summary = _encFormatPeek(data.payload); } catch (e) { /* ignore */ }
            ctx.fillStyle = '#d2b45a'; ctx.font = '15px monospace';
            _encWrapText(ctx, summary || 'Reward claimed.', 38, 160, W - 76, 22, 4);
            _encDrawLeaveButton(ctx, '🏃 LEAVE', () => dsClearNode(node.id));
            return;
        }
        ctx.fillStyle = '#f0c14b'; ctx.font = 'bold 14px monospace';
        ctx.fillText('CHOOSE A GLIMPSE', 38, 98);
        const opts = (data.options || []).slice(0, 3);
        const bw = W - 76, bh = 46;
        let y = 114;
        opts.forEach((opt) => {
            ctx.fillStyle = 'rgba(240,193,75,0.10)'; ctx.fillRect(38, y, bw, bh);
            ctx.strokeStyle = 'rgba(240,193,75,0.45)'; ctx.lineWidth = 2; ctx.strokeRect(38, y, bw, bh);
            ctx.fillStyle = '#f4e0a0'; ctx.font = 'bold 17px monospace'; ctx.textAlign = 'center';
            ctx.fillText(_encTrim(opt.label || opt.type, 34), W / 2, y + bh / 2 + 6); ctx.textAlign = 'left';
            encHits.push(_encRect(38, y, bw, bh, () => _encChooseTreasure(node.id, opt.type)));
            y += bh + 10;
        });
        _encDrawLeaveButton(ctx, '🏃 SKIP', () => dsClearNode(node.id));
    }

    function _loadTreasureEncounter(nodeId) {
        fetch(dsApiUrl(`/api/plugins/the_daily/treasure/${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } })
            .then(r => r.text())
            .then(t => { if (!encActive || encNodeId !== nodeId) return; encData = t ? JSON.parse(t) : {}; drawEncounterCanvas(); })
            .catch(() => { if (!encActive || encNodeId !== nodeId) return; encData = { error: true }; drawEncounterCanvas(); });
    }

    function _encChooseTreasure(nodeId, type) {
        encData = null; drawEncounterCanvas();  // "examining…" while the choice posts
        fetch(dsApiUrl(`/api/plugins/the_daily/treasure/${encodeURIComponent(nodeId)}`), {
            method: 'POST',
            headers: { 'X-Install-Id': dsInstallId(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ peek_type: type }),
        })
            .then(() => { if (!encActive || encNodeId !== nodeId) return; _loadTreasureEncounter(nodeId); })
            .catch(() => { if (!encActive || encNodeId !== nodeId) return; encData = { error: true }; drawEncounterCanvas(); });
    }

    function _encDrawShopBody(ctx, node) {
        const W = ENC_W, H = ENC_H;
        const data = encData;
        if (data == null) {
            ctx.fillStyle = '#d4dce8'; ctx.font = '16px monospace';
            ctx.fillText('Browsing the stall…', 38, 126);
            return;
        }
        if (data.error) {
            ctx.fillStyle = '#f87171'; ctx.font = '16px monospace';
            _encWrapText(ctx, String(data.error), 38, 126, W - 76, 23, 3);
            _encDrawLeaveButton(ctx, '✕ LEAVE', () => window._dsDungeonDismiss());
            return;
        }
        ctx.fillStyle = '#f0c14b'; ctx.font = 'bold 14px monospace';
        ctx.fillText("TODAY'S OFFER", 38, 98);
        ctx.textAlign = 'right'; ctx.fillStyle = '#e8c040'; ctx.font = 'bold 16px monospace';
        ctx.fillText(`🪙 ${data.tokens != null ? data.tokens : 0}`, W - 38, 98); ctx.textAlign = 'left';
        const offer = new Set((data.discount && data.discount.items) || []);
        let items = (data.items || []).filter(i => offer.has(i.id));
        if (!items.length) items = (data.items || []);
        items = items.slice(0, 2);
        const rowH = 74;
        let y = 110;
        items.forEach((item) => {
            ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(26, y, W - 52, rowH - 8);
            ctx.fillStyle = '#fff'; ctx.font = 'bold 18px monospace';
            ctx.fillText(_encTrim(item.name, 28), 38, y + 26);
            ctx.fillStyle = '#a3adbd'; ctx.font = '13px monospace';
            ctx.fillText(_encTrim(item.description || item.type || '', 42), 38, y + 46);
            const cost = item.discounted_cost != null ? item.discounted_cost : item.cost;
            ctx.fillStyle = '#e8c040'; ctx.font = 'bold 15px monospace';
            ctx.fillText(`🪙 ${cost}`, 38, y + 64);
            const owned = item.owned, afford = item.affordable, busy = data._buying;
            const bw = 140, bh = 46, bx = W - 26 - bw - 10, by = y + (rowH - 8) / 2 - bh / 2;
            let label, fill, action;
            if (owned) { label = 'OWNED'; fill = '#243a30'; action = null; }
            else if (busy) { label = '…'; fill = '#2a2a2a'; action = null; }
            else if (afford) { label = 'BUY'; fill = '#2f6fc2'; action = () => _encBuyShop(node.id, item.id); }
            else { label = 'NEED 🪙'; fill = '#3a2a2a'; action = null; }
            ctx.fillStyle = fill; ctx.fillRect(bx, by, bw, bh);
            ctx.fillStyle = action ? '#fff' : '#8a93a3'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
            ctx.fillText(label, bx + bw / 2, by + bh / 2 + 6); ctx.textAlign = 'left';
            if (action) encHits.push(_encRect(bx, by, bw, bh, action));
            y += rowH;
        });
        if (data._err) {
            ctx.fillStyle = '#f87171'; ctx.font = '13px monospace'; ctx.textAlign = 'center';
            ctx.fillText(_encTrim(data._err, 46), W / 2, H - 66); ctx.textAlign = 'left';
        }
        _encDrawLeaveButton(ctx, '🏃 LEAVE', () => dsClearNode(node.id));
    }

    function _loadShopEncounter(nodeId) {
        fetch(dsApiUrl(`/api/plugins/the_daily/shop?node_id=${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } })
            .then(r => r.text())
            .then(t => { if (!encActive || encNodeId !== nodeId) return; encData = t ? JSON.parse(t) : {}; drawEncounterCanvas(); })
            .catch(() => { if (!encActive || encNodeId !== nodeId) return; encData = { error: 'Failed to load shop.' }; drawEncounterCanvas(); });
    }

    function _encBuyShop(nodeId, itemId) {
        if (encData) { encData._buying = true; encData._err = null; }
        drawEncounterCanvas();
        fetch(dsApiUrl('/api/plugins/the_daily/shop/buy'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
            body: JSON.stringify({ item_id: itemId, node_id: nodeId }),
        })
            .then(r => r.text())
            .then(t => {
                if (!encActive || encNodeId !== nodeId) return;
                const res = t ? JSON.parse(t) : {};
                if (res.error) { if (encData) { encData._buying = false; encData._err = res.error; } drawEncounterCanvas(); return; }
                if (res.effect && res.effect.rerolled) { dsLoadToday(); return; }
                _loadShopEncounter(nodeId);  // refresh items + token balance
            })
            .catch(() => { if (!encActive || encNodeId !== nodeId) return; if (encData) { encData._buying = false; encData._err = 'Purchase failed.'; } drawEncounterCanvas(); });
    }

    function _encDrawSongBody(ctx, node) {
        const W = ENC_W, H = ENC_H;
        const cleared = new Set(d.cleared_node_ids || []);
        const available = new Set(d.available_node_ids || []);
        const canPlay = available.has(encNodeId) || cleared.has(encNodeId);
        const opts = _encSongOptions(node).slice(0, 3);
        const rowH = opts.length > 1 ? 80 : 96;
        let y = 84;
        opts.forEach((o) => {
            const song = o.song;
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(26, y, W - 52, rowH - 12);
            if (!song) {
                ctx.fillStyle = '#f87171'; ctx.font = '17px monospace';
                ctx.fillText('Song missing from payload.', 38, y + 40);
            } else {
                const title = (o.boss && !d.boss_revealed) ? '???' : (song.title || '');
                const local = song.has_locally && song.local_filename;
                const bw = 138, bh = 46, bx = W - 26 - bw - 10, by = y + (rowH - 10) / 2 - bh / 2;
                ctx.fillStyle = '#9fb4ff'; ctx.font = 'bold 14px monospace';
                ctx.fillText(_encTrim(o.label.toUpperCase(), 30), 38, y + 26);
                // Title shares the button's vertical band, so trim it to the gap
                // left of the button; the meta line sits below the button and gets
                // the full panel width.
                ctx.fillStyle = '#fff'; ctx.font = 'bold 24px monospace';
                ctx.fillText(_encTrimW(ctx, title, bx - 38 - 12), 38, y + 54);
                ctx.fillStyle = '#b6c0ce'; ctx.font = '16px monospace';
                const meta = `${song.artist || ''} · ${song.tuning || '—'}${song.duration ? ' · ' + dsFmtDuration(song.duration) : ''}`;
                ctx.fillText(_encTrimW(ctx, meta, W - 26 - 38), 38, y + 78);
                let label, fill, action;
                if (local && canPlay) { label = '▶ PLAY'; fill = '#2f6fc2'; action = () => dsPlayMapNode(node.id, song.cf_id, song.local_filename); }
                else if (!local) { label = 'GET'; fill = '#2f6fc2'; action = () => dsAcquire(song.cf_id, node.id, song.cf_url, null); }
                else { label = 'LOCKED'; fill = '#26262a'; action = null; }
                ctx.fillStyle = fill; ctx.fillRect(bx, by, bw, bh);
                ctx.fillStyle = action ? '#fff' : '#8a93a3'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
                ctx.fillText(label, bx + bw / 2, by + bh / 2 + 6); ctx.textAlign = 'left';
                if (action) encHits.push(_encRect(bx, by, bw, bh, action));
            }
            y += rowH;
        });
        _encDrawLeaveButton(ctx, '✕ LEAVE', () => window._dsDungeonDismiss());
    }

    function _loadRestEncounter(nodeId) {
        fetch(dsApiUrl(`/api/plugins/the_daily/rest/${encodeURIComponent(nodeId)}`),
            { headers: { 'X-Install-Id': dsInstallId() } })
            .then(r => r.text())
            .then(t => {
                if (!encActive || encNodeId !== nodeId) return;
                encData = t ? JSON.parse(t) : {};
                drawEncounterCanvas();
            })
            .catch(() => {
                if (!encActive || encNodeId !== nodeId) return;
                encData = { error: true };
                drawEncounterCanvas();
            });
    }

    function showEncounterDiegetic(nodeId) {
        const node = nodeById(nodeId);
        encNodeId = nodeId;
        encActive = true;
        encData = null;
        state.phase = 'encounter';
        // Release the mouse so the OS cursor can click the in-world surface.
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        // Materialise the panel a short distance ahead of the player's view, at
        // eye level, facing them. Placed once on open and left static (the camera
        // is frozen during the encounter) so it reads as a thing in the world.
        const fwdX = -Math.sin(qc.yaw), fwdZ = -Math.cos(qc.yaw), dist = 2.4;
        encMesh.position.set(camera.position.x / WS + fwdX * dist, CY + 0.12, camera.position.z / WS + fwdZ * dist);
        encMesh.rotation.set(0, qc.yaw, 0);
        encMesh.visible = true;
        drawEncounterCanvas();
        // Rest/treasure/shop nodes load their state asynchronously, then redraw.
        if (node && node.type === 'rest') _loadRestEncounter(nodeId);
        else if (node && node.type === 'treasure') _loadTreasureEncounter(nodeId);
        else if (node && node.type === 'shop') _loadShopEncounter(nodeId);
    }

    // ── Face-tween (Skyrim-style camera turn) ──────────────────────────────────
    function startFaceTween(nodeId) {
        const n = nodeById(nodeId);
        const a = n ? INTERACT_ANCHOR[n.type] : null;
        if (!a) { showEncounter(nodeId); return; }
        // Prop world position (roomGroup + anchor, scaled by WS).
        const pw = (roomGroup.position.x + a.x) * WS;
        const pz = (roomGroup.position.z + a.z) * WS;
        const cx = camera.position.x, cz = camera.position.z;
        // Target yaw (shortest-path wrapped).
        const rawYaw = Math.atan2(cx - pw, cz - pz);
        let dy = rawYaw - qc.yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        faceStartYaw = qc.yaw;
        faceTargetYaw = qc.yaw + dy;
        // Pitch to center the encounter panel both x and y. The panel always
        // spawns at local Y = CY + 0.12 (slightly above eye level), at a fixed
        // distance of 2.4 local units ahead of the camera. Compute the angle so
        // the panel lands in the middle of the view vertically.
        const panelWorldY = (CY + 0.12) * WS;
        const encDist = 2.4 * WS;
        const rawPitch = -Math.atan2(panelWorldY - camera.position.y, encDist);
        const PITCH_LIMIT = 80 * Math.PI / 180;
        faceStartPitch = qc.pitch;
        faceTargetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, rawPitch));
        faceTween = 0;
        state.phase = 'facing';
        // Clear any accumulated mouse deltas so the view doesn't snap on return.
        while (qc.mxAccum.length) qc.mxAccum.shift();
        while (qc.myAccum.length) qc.myAccum.shift();
    }

    // ── Encounter ─────────────────────────────────────────────────────────────
    function showEncounter(nodeId) {
        const route = nodeById(nodeId);
        // Song + rest nodes render in-world; treasure/shop use the docked DOM panel.
        if (route && DIEGETIC_TYPES.has(route.type)) { showEncounterDiegetic(nodeId); return; }
        state.phase = 'encounter';
        // Release the mouse so the DOM encounter panel is clickable.
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        const n = nodeById(nodeId);
        if (!n) return;

        const [col] = DOOR_COL[n.type] || [0x222222];
        const border = '#' + col.toString(16).padStart(6, '0');
        const icon = NODE_TYPE_ICONS[n.type] || '●';

        encounterEl.style.display = 'flex';
        encounterEl.innerHTML = `
            <div style="background:#080808;border:3px solid ${border};max-width:520px;width:100%;padding:20px;position:relative;max-height:90vh;overflow-y:auto;">
                <button onclick="window._dsDungeonDismiss()" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#555;font-size:1.2rem;cursor:pointer;line-height:1;">✕</button>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1a1a1a;font-family:monospace;">
                    <span style="font-size:1.4rem;">${icon}</span>
                    <span style="color:#888;font-size:0.8rem;letter-spacing:.1em;">${esc((n.type||'').toUpperCase())}</span>
                </div>
                <div id="ds-map-panel" class="space-y-3"></div>
            </div>`;

        dsOpenNode(nodeId);
    }

    window._dsDungeonDismiss = function () {
        encounterEl.style.display = 'none';
        encMesh.visible = false;
        encActive = false;
        encNodeId = null;
        state.phase = 'idle';
        updateSelection();
    };

    // ── RAF loop ──────────────────────────────────────────────────────────────
    const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
    let prevTime = performance.now();

    // Live diagnostics for the Quake-feel tuning workflow (and the headless
    // harness, which can read this instead of eyeballing screenshots). Lightweight
    // — renderer.info is already tracked by three; the rest are cheap reads. Lives
    // on window so it's inspectable from the console; nulled on destroy.
    const diag = { fps: 0, dt: 0, _acc: 0, _n: 0, phase: 'idle', node: null, sealed: true,
        yaw: 0, pitch: 0, speed: 0, vel: { x: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 },
        keys: null, doors: 0, tris: 0, calls: 0 };
    window.__DS_DUNGEON_DIAG__ = diag;

    function loop(now) {
        state.rafId = requestAnimationFrame(loop);
        const dt = Math.min((now - prevTime) / 1000, 0.1);
        prevTime = now;

        // Keep the warm follow-lamp on the camera (positions are world-local; the
        // world group applies × WS, the camera is in world units).
        playerLight.position.set(camera.position.x / WS, camera.position.y / WS + 0.4, camera.position.z / WS);

        // Quake 10 Hz lightstyle flicker — choppy stepped fire, not a smooth
        // sine. Two desynced phases so the torches never pulse in lockstep.
        const ls1 = _dsSampleLightstyle('fire', now, 0);
        const ls2 = _dsSampleLightstyle('fire', now, 7.3);
        if (roomProp && roomProp._altarGlow) {
            // Mystery room: faint candle-sputter purple torches + ethereal pulse
            torch1.intensity = 0.16 + _dsSampleLightstyle('candle', now, 0) * 0.12;
            torch2.intensity = 0.12 + _dsSampleLightstyle('candle', now, 5) * 0.10;
            roomProp._altarGlow.intensity = 1.0 + Math.sin(now * 0.0008) * 0.4 + Math.sin(now * 0.0031) * 0.15;
        } else if (!campfireLight) {
            torch1.intensity = 2.0 * (0.74 + ls1 * 0.30);
            torch2.intensity = 1.6 * (0.74 + ls2 * 0.30);
        }
        if (campfireLight) {
            // Busier fire-style flicker for the campfire than the wall torches.
            campfireLight.intensity = 2.6 * (0.72 + _dsSampleLightstyle('fire', now, 3.1) * 0.34);
        }
        // Animate the visible torch fires (corridor themes only). Flame body
        // flickers in scale + tints to its torch's colour; embers drift upward.
        for (let fi = 0; fi < torchFlames.length; fi++) {
            const fl = torchFlames[fi];
            const tl = fi === 0 ? torch1 : torch2;
            const lit = flamesVisible && tl.intensity > 0.05;
            if (fl.visible !== lit) fl.visible = lit;
            if (!lit) continue;
            const sy = 0.8 + (fi === 0 ? ls1 : ls2) * 0.28;
            fl._core.scale.set(0.92 + Math.sin(now * 0.02 + fi) * 0.12, sy, 0.92 + Math.cos(now * 0.017 + fi) * 0.12);
            fl._tip.scale.set(0.9, sy * 1.15, 0.9);
            fl._core.material.color.copy(tl.color);
            fl._tip.material.color.copy(tl.color).lerp(_WHITE, 0.55);
            fl._embers.material.color.copy(tl.color);
            const ep = fl._embers.geometry.attributes.position, arr = ep.array, ev = fl._emberVel;
            for (let i = 0; i < ev.length; i++) {
                let y = arr[i*3+1] + ev[i] * dt;
                if (y > 1.0) { y = 0; arr[i*3] = (Math.random()-0.5)*0.14; arr[i*3+2] = (Math.random()-0.5)*0.14; }
                arr[i*3+1] = y;
            }
            ep.needsUpdate = true;
        }

        if (state.phase === 'idle') {
            qc.applyLook();   // consume accumulated Pointer-Lock mouse deltas
            moveStep(dt);     // free walk + occupancy collision + room detection
            // Footsteps while actually moving across the plan.
            const spd = Math.hypot(qc.vel.x, qc.vel.z);
            if (spd > 30) {
                state._stepAcc = (state._stepAcc || 0) + spd * dt;
                if (state._stepAcc > 220) { state._stepAcc = 0; if (_dsAudio) _dsAudio.playFootstep(0.5); }
            }
            // In-world prop interaction: billboard faces the player, lights up and
            // arms Enter once you've walked into the prop's zone.
            if (promptMesh.visible) {
                // Yaw-billboard: prompt's front face turns to the camera. The mesh
                // is under roomGroup (at the occupied room's centre), so its world
                // xz is (roomGroup.position + local) × WS.
                const mwx = (roomGroup.position.x + promptMesh.position.x) * WS;
                const mwz = (roomGroup.position.z + promptMesh.position.z) * WS;
                promptMesh.rotation.y = Math.atan2(camera.position.x - mwx, camera.position.z - mwz);
                const near = promptArmed && isNearProp();
                if (near !== promptNear) {
                    promptNear = near;
                    drawPromptCanvas(near);
                    interactBtn.style.display = near ? 'block' : 'none';
                }
                // Attract pulse while armed but not yet reached; steady once near.
                promptMat.opacity = !promptArmed ? 0.5
                    : promptNear ? 1
                    : 0.78 + Math.sin(now * 0.005) * 0.18;
            }
        } else if (state.phase === 'facing') {
            faceTween = Math.min(faceTween + dt / 0.35, 1);
            const t = easeInOutCubic(faceTween);
            qc.yaw = faceStartYaw + (faceTargetYaw - faceStartYaw) * t;
            qc.pitch = faceStartPitch + (faceTargetPitch - faceStartPitch) * t;
            if (faceTween >= 1) showEncounter(state.nodeId);
        }

        tickExplosions(dt);  // advance any in-flight rubble detonations

        // Roll only applies to free movement; scripted walk/encounter stay level.
        // Detonation camera-shake: decaying random jitter layered on the view
        // angles. Purely visual (rotation is rebuilt from qc each frame, so this
        // never corrupts collision/position). ~6 Hz settle.
        camShake = Math.max(0, camShake - dt * 0.14);
        const shP = (Math.random() - 0.5) * camShake;
        const shY = (Math.random() - 0.5) * camShake;
        const shR = (Math.random() - 0.5) * camShake * 1.6;
        camera.rotation.set(qc.pitch + shP, qc.yaw + shY, (state.phase === 'idle' ? qc.viewRoll : 0) + shR);
        renderer.render(scene, camera);

        // ── Diagnostics snapshot (post-render so renderer.info is current) ──
        diag._acc += dt; diag._n++;
        if (diag._acc >= 0.5) { diag.fps = Math.round(diag._n / diag._acc); diag._acc = 0; diag._n = 0; }
        diag.dt = +(dt * 1000).toFixed(1);          // ms
        diag.phase = state.phase;
        diag.node = state.nodeId;
        diag.sealed = !currentCleared();
        diag.yaw = +qc.yaw.toFixed(3); diag.pitch = +qc.pitch.toFixed(3);
        diag.speed = Math.round(Math.hypot(qc.vel.x, qc.vel.z));
        diag.vel = { x: Math.round(qc.vel.x), z: Math.round(qc.vel.z) };
        diag.pos = { x: Math.round(camera.position.x), y: Math.round(camera.position.y), z: Math.round(camera.position.z) };
        diag.keys = qc.keys;
        diag.doors = corridors.filter(c => !c.open).length;   // rocked passages remaining
        // Real scene complexity, captured before the post-FX quad reset info (see
        // _dsInstallPostFx). Falls back to live info if the post pass isn't active.
        const _si = renderer.__dsSceneInfo;
        diag.tris = _si ? _si.triangles : renderer.info.render.triangles;
        diag.calls = _si ? _si.calls : renderer.info.render.calls;

        // Throttled minimap refresh (~8 fps) — keeps the pulse alive while standing still.
        const _mmLast = state._lastMinimapDraw || 0;
        if (now - _mmLast > 120) {
            state._lastMinimapDraw = now;
            drawMinimap();
        }
    }

    // ── Input (Quake controls) ──────────────────────────────────────────────────
    // WASD / arrows move (mouse turns), so left/right strafe rather than cycle.
    const setMoveKey = (e, down) => qc.setMoveKey(e, down);
    const onKey = (e) => {
        if (_dsAudio) _dsAudio.init();
        if (state.phase === 'encounter') {
            if (e.key === 'Escape') { window._dsDungeonDismiss(); e.preventDefault(); }
            return;
        }
        if (state.phase === 'facing') {
            if (e.key === 'Escape') { state.phase = 'idle'; e.preventDefault(); }
            return;
        }
        if (e.key === 'Escape') {
            if (pointerLocked && document.exitPointerLock) document.exitPointerLock();
            _dsShowPauseMenu(d); e.preventDefault(); return;
        }
        // Interact with the current room's prop — only when standing at it.
        if ((e.key === 'Enter' || e.key === 'e' || e.key === 'E') &&
            state.phase === 'idle' && promptArmed && promptNear) {
            startFaceTween(state.nodeId); e.preventDefault(); return;
        }
        if (setMoveKey(e, true)) { hideHint(); e.preventDefault(); }
    };
    const onKeyUp = (e) => { if (setMoveKey(e, false)) e.preventDefault(); };
    const onMouseMove = (e) => {
        if (!pointerLocked || state.phase !== 'idle') return;
        qc.addMouse(e.movementX, e.movementY);
    };
    const onPointerLockChange = () => {
        pointerLocked = (document.pointerLockElement === canvas);
        if (pointerLocked) { hideHint(); dunReticle.classList.add('ds-reticle-on'); }
        else { dunReticle.classList.remove('ds-reticle-on'); }
    };
    const onBlur = () => { qc.clearKeys(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('blur', onBlur);
    canvas.addEventListener('click', (e) => {
        if (_dsAudio) _dsAudio.init();
        // While a diegetic encounter is open, a click hit-tests its in-world
        // buttons via the raycaster instead of (re)acquiring pointer lock.
        if (encActive && encMesh.visible) {
            const rect = canvas.getBoundingClientRect();
            encMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            encMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            encRaycaster.setFromCamera(encMouse, camera);
            const hits = encRaycaster.intersectObject(encMesh);
            if (hits.length && hits[0].uv) {
                const ux = hits[0].uv.x, uy = hits[0].uv.y;
                for (const h of encHits) {
                    if (ux >= h.x1 && ux <= h.x2 && uy >= h.y1 && uy <= h.y2) { h.action(); return; }
                }
            }
            return;
        }
        if (state.phase === 'idle' && !pointerLocked && canvas.requestPointerLock) canvas.requestPointerLock();
    });

    // ── Public API ────────────────────────────────────────────────────────────
    // Pick the world spawn point: the saved coordinate if any, else the antechamber
    // in front of the entrance rooms (so the player walks into row 0 themselves).
    function spawnPoint() {
        try {
            const saved = JSON.parse(localStorage.getItem('ds_dun_pos_' + d.date) || 'null');
            if (saved && typeof saved.x === 'number') return { x: saved.x, z: saved.z };
        } catch (e) {}
        if (antechamber) {
            return { x: ((antechamber.x0 + antechamber.x1) / 2) * WS, z: ((antechamber.z0 + antechamber.z1) / 2) * WS };
        }
        return { x: 0, z: 0 };
    }

    // Drop the player into a room at its near (back) edge, facing into the
    // dungeon. enterRoom themes it and — since the camera is now inside the rect —
    // commits the lane (locking siblings, which rock over).
    function placeInRoom(nodeId) {
        const r = rooms[nodeId];
        resetView();
        if (r) {
            camera.position.x = r.x * WS;
            camera.position.z = (r.z + r.hd * 0.6) * WS;   // just inside the near wall
            camera.position.y = EYE;
        }
        qc.yaw = 0;
        enterRoom(nodeId);
        savePos();
    }

    // Pre-start path picker (ADR 0012): instead of walking the antechamber to the
    // lane you want, choose your starting entrance up front. Pauses the dungeon
    // (phase 'encounter' freezes movement) until a path is picked.
    function showPathPicker(entranceIds) {
        state.phase = 'encounter';
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        const songMap = Object.fromEntries((d.songs || []).map(s => [s.cf_id, s]));
        const opts = entranceIds.map((id, i) => {
            const n = nodeById(id);
            const icon = NODE_TYPE_ICONS[n?.type] || '◇';
            const song = songMap[n?.cf_id];
            const title = song ? esc(_encTrim(song.title, 28)) : (n?.type || '').toUpperCase();
            const sub = song ? esc(_encTrim([song.artist, song.tuning].filter(Boolean).join(' · '), 34)) : 'Choose this path';
            const local = song && song.has_locally;
            return `<button class="ds-path-opt" data-id="${id}" style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#0c0c0c;border:1px solid #1d4ed8;border-radius:12px;padding:12px 14px;margin:6px 0;color:#d4dce8;font-family:monospace;cursor:pointer;">
                <span style="font-size:1.6rem;width:32px;text-align:center;">${icon}</span>
                <span style="flex:1;min-width:0;">
                    <span style="display:block;font-size:0.6rem;letter-spacing:.14em;color:#3a78c9;">PATH ${i + 1}</span>
                    <span style="display:block;font-weight:bold;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</span>
                    <span style="display:block;font-size:0.72rem;color:#8a93a3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sub}</span>
                </span>
                ${local ? '<span style="color:#22c55e;font-size:0.7rem;">● OWNED</span>' : ''}
            </button>`;
        }).join('');
        encounterEl.style.alignItems = 'center';
        encounterEl.style.display = 'flex';
        encounterEl.innerHTML = `
            <div style="background:#080808;border:3px solid #1d4ed8;border-radius:12px;max-width:460px;width:100%;padding:18px;max-height:90vh;overflow-y:auto;">
                <div style="font-family:monospace;color:#3a78c9;font-size:0.75rem;letter-spacing:.12em;margin-bottom:6px;">⚔ CHOOSE YOUR STARTING PATH</div>
                <div style="font-family:monospace;color:#555;font-size:0.65rem;margin-bottom:10px;">You commit to this lane — the others seal behind you.</div>
                ${opts}
            </div>`;
        encounterEl.querySelectorAll('.ds-path-opt').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_dsAudio) _dsAudio.init();
                const id = btn.getAttribute('data-id');
                encounterEl.style.display = 'none';
                encounterEl.style.alignItems = 'flex-end';   // restore encounter docking
                encounterEl.innerHTML = '';
                state.phase = 'idle';
                placeInRoom(id);
            });
        });
    }

    function start() {
        buildFloorplan();                 // lay out the whole contiguous dungeon
        _dsTextureAllSurfaces(THREE, scene, _floorplanDisposables);   // give every solid surface a real texture
        // Reset the controller FIRST (it parks the camera at the origin), then
        // place the player at the spawn point — order matters (ADR 0012).
        resetView();
        const sp = spawnPoint();
        camera.position.x = sp.x;
        camera.position.z = sp.z;
        camera.position.y = EYE;
        qc.yaw = 0;   // face into the dungeon (−Z) on spawn
        prevTime = performance.now();
        state.rafId = requestAnimationFrame(loop);

        // Fresh run (nothing committed/cleared): let the player PICK their starting
        // path up front rather than walking the antechamber to it (ADR 0012). With
        // a single open entrance, just drop them in; with several, show the picker.
        const committed = new Set(d.committed_node_ids || []);
        const cleared = new Set(d.cleared_node_ids || []);
        const avail = new Set(d.available_node_ids || []);
        const entranceIds = (map.nodes || [])
            .filter(n => (n.row || 0) === 0 && rooms[n.id] && avail.has(n.id))
            .map(n => n.id);
        // "Fresh" is purely a progress signal — not saved position — so a player
        // who previewed but didn't pick still gets the picker on reload.
        const fresh = !committed.size && !cleared.size;

        if (fresh && entranceIds.length > 1) {
            enterRoom(entranceIds[0]);   // preview dressing/HUD behind the picker
            showPathPicker(entranceIds);
            return;                       // picker drives placement + commit
        }
        if (fresh && entranceIds.length === 1) {
            placeInRoom(entranceIds[0]);
        } else {
            // Resume: saved coord or in-progress day — occupy whatever room we land in.
            const here = roomAt(camera.position.x, camera.position.z) || map.start;
            enterRoom(here);
        }

        // Returning from a song that cleared a room: detonate that room's exit
        // rubble on arrival so song rooms get the same blow-open beat as in-place
        // clears (ADR 0012). Backend payload already reflects the clear.
        if (_dsRoomJustCleared) {
            const just = _dsRoomJustCleared;
            _dsRoomJustCleared = null;
            syncSections(just);
        }
    }

    function destroy() {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        if (_sealedTimer) { clearTimeout(_sealedTimer); _sealedTimer = null; }
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKeyUp);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('pointerlockchange', onPointerLockChange);
        window.removeEventListener('blur', onBlur);
        if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
        if (dunReticle.parentNode) dunReticle.parentNode.removeChild(dunReticle);
        window._dsDungeonDismiss = null;
        window._dsDungeonBossTorches = null;
        window.__DS_DUNGEON_DIAG__ = null;
        clearRoomProp();
        roomGroup.remove(promptMesh);
        promptMesh.geometry.dispose();
        promptMat.dispose();
        promptTex.dispose();
        world.remove(encMesh);
        encMesh.geometry.dispose();
        encMat.dispose();
        encTex.dispose();
        bossPerimTorches.forEach(l => roomGroup.remove(l));
        world.remove(playerLight);
        torchFlames.forEach(fl => { if (fl.parent) fl.parent.remove(fl); });
        flameDisposables.forEach(x => x.dispose());
        // Floorplan geometry: walls, big floor/ceil, rubble gates, in-flight bursts.
        if (wallMesh) { world.remove(wallMesh); wallMesh.geometry.dispose(); }
        if (roomMeshes.floor) world.remove(roomMeshes.floor);
        if (roomMeshes.ceil) world.remove(roomMeshes.ceil);
        rubbleGates.forEach(rg => { world.remove(rg.group); });
        explosions.forEach(ex => {
            ex.pieces.forEach(p => world.remove(p.mesh));
            if (ex.sparks) { world.remove(ex.sparks); ex.sparks.geometry.dispose(); ex.sparks.material.dispose(); }
            if (ex.flash) world.remove(ex.flash);
        });
        renderer.dispose();
        // Base materials + their textures and the floorplan-specific disposables
        // (rock geos/mats, plane geos, post-pass cloned surface materials).
        [wallMat, floorMat, ceilMat, backMat, doorFrameMat].forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
        _floorplanDisposables.forEach(x => { try { x.dispose(); } catch (e) {} });
    }

    // Refresh the dungeon's view without rebuilding it. Caller has mutated `d`
    // (the captured daily payload) in place — typically after a rescan turns
    // missing songs into playable ones. We just re-render HUD/minimap and, if
    // an encounter is open, re-populate its panel so the new song state shows.
    function refresh() {
        updateSelection();
        if (encActive) {
            drawEncounterCanvas();
        } else if (state.phase === 'encounter') {
            const panel = document.getElementById('ds-map-panel');
            if (panel) dsOpenNode(state.nodeId);
        }
    }

    function setAmbientVolume(v) { if (_dsAudio) _dsAudio.setAmbientVol(v); }
    return { start, destroy, refresh, clearCurrentRoom, setAmbientVolume, setSfxVolume: function(v) { if (_dsAudio) _dsAudio.setSfxVol(v); } };
}
