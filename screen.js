// Daily Setlist plugin

let _dsData = null;        // last /today response
let _dsSigned = false;     // whether user signed today
let _dsSigning = false;    // in-flight guard for sign submit
let _dsConfettiDone = false;
let _dsRating = null;      // selected rating: -1, 1, 2, or null
let _dsReturnAfterPlayback = false;
let _dsReturnListenerRegistered = false;

function _dsSignKey(date) { return `ds_signed_${date}`; }

// ── Screen hook ──────────────────────────────────────────────────────────────
(function () {
    const orig = window.showScreen;
    window.showScreen = function (id) {
        orig(id);
        if (id === 'plugin-the_daily') {
            if (!_dsReturnListenerRegistered) {
                _dsReturnListenerRegistered = true;
                window.slopsmith.on('song:ended', () => {
                    if (_dsReturnAfterPlayback) {
                        _dsReturnAfterPlayback = false;
                        showScreen('plugin-the_daily');
                        dsInit();
                    }
                });
            }
            dsInit();
        }
    };
})();

// ── Init ─────────────────────────────────────────────────────────────────────
async function dsInit() {
    _dsConfettiDone = false;
    dsShow('loading');
    try {
        const resp = await fetch('/api/plugins/the_daily/today');
        const text = await resp.text();
        _dsData = text ? JSON.parse(text) : null;
        if (!_dsData) {
            dsShowError('Empty response from server.');
            return;
        }
        if (_dsData.error) {
            dsShowError(_dsData.error);
            return;
        }
        dsRender();
        if (_dsData.is_complete && !_dsConfettiDone) {
            dsShow('complete');
            dsRenderComplete();
        } else {
            dsShow('setlist');
        }
    } catch (e) {
        dsShowError('Failed to load daily setlist.');
    }
}

// ── Render setlist view ───────────────────────────────────────────────────────
function dsRender() {
    const d = _dsData;
    const mod = d.modifier;

    document.getElementById('ds-modifier-icon').textContent = mod.icon;
    document.getElementById('ds-modifier-label').textContent = mod.label;
    document.getElementById('ds-seed').textContent = d.seed || '';
    document.getElementById('ds-modifier-desc').textContent = mod.description;
    document.getElementById('ds-day-name').textContent = d.day_name;
    document.getElementById('ds-day-number').textContent = `#${d.day_number}`;
    document.getElementById('ds-date').textContent = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const fallback = document.getElementById('ds-fallback-notice');
    fallback.classList.toggle('hidden', !d.fallback);

    const pct = d.song_count > 0 ? Math.round((d.progress.done / d.progress.total) * 100) : 0;
    document.getElementById('ds-progress-bar').style.width = pct + '%';
    document.getElementById('ds-progress-label').textContent = `${d.progress.done} / ${d.progress.total}`;

    const container = document.getElementById('ds-songs');
    container.innerHTML = d.songs.map((s, i) => dsSongCard(s, i, mod.is_blindside)).join('');
}

function dsSongCard(song, index, blindside) {
    const num = `<span class="text-xs text-gray-600 w-6 text-center flex-shrink-0">${index + 1}</span>`;
    const title = blindside && !song.done ? '???' : esc(song.title);
    const artist = esc(song.artist);
    const tuning = song.tuning ? `<span class="text-xs text-gray-600 ml-2">${esc(song.tuning)}</span>` : '';

    let border = 'border-gray-800/30';
    let opacity = '';
    let action = '';

    if (song.done) {
        border = 'border-green-800/30';
        opacity = 'opacity-60';
        action = `<span class="text-green-500 text-lg flex-shrink-0">✓</span>`;
        if (song.has_locally) {
            action += `<button onclick='dsPlay(${song.cf_id},"${esc(song.local_filename)}")'
                class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition flex-shrink-0">Replay</button>`;
        }
    } else if (song.has_locally) {
        border = 'border-accent/30';
        action = `<button onclick='dsPlay(${song.cf_id},"${esc(song.local_filename)}")'
            class="bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-xs font-semibold text-white transition flex-shrink-0">Play</button>`;
    } else {
        action = `<a href="${esc(song.cf_url)}" target="_blank" rel="noopener"
            class="px-4 py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-xl text-xs text-gray-300 transition flex-shrink-0 whitespace-nowrap">
            Get on CF ↗</a>`;
    }

    const duration = song.duration ? `<span class="text-xs text-gray-600">${dsFmtDuration(song.duration)}</span>` : '';

    return `
        <div class="flex items-center gap-3 bg-dark-700/40 border ${border} rounded-xl p-4 ${opacity} transition">
            ${num}
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-medium text-white">${title}</span>
                    ${tuning}
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-xs text-gray-500">${artist}</span>
                    ${duration}
                    ${!song.has_locally && !song.done ? '<span class="text-xs text-yellow-600">· Download &amp; rescan to play</span>' : ''}
                </div>
            </div>
            <div class="flex items-center gap-2">
                ${action}
            </div>
        </div>`;
}

function dsFmtDuration(secs) {
    if (typeof secs === 'string') return secs;
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Play a song ───────────────────────────────────────────────────────────────
async function dsPlay(cfId, filename) {
    _dsReturnAfterPlayback = true;
    try {
        const resp = await fetch('/api/plugins/the_daily/mark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cf_id: cfId }),
        });

        if (resp.ok) {
            const text = await resp.text();
            if (text) {
                const result = JSON.parse(text);

                // Update local state
                if (_dsData) {
                    _dsData.progress = result.progress;
                    const song = _dsData.songs.find(s => s.cf_id === cfId);
                    if (song) song.done = true;
                    _dsData.is_complete = result.is_complete;
                    dsRender();

                    if (result.is_complete && !_dsConfettiDone) {
                        setTimeout(() => {
                            dsShow('complete');
                            dsRenderComplete();
                        }, 800);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to mark song:', e);
    }

    playSong(encodeURIComponent(filename));
}

// ── Complete view ─────────────────────────────────────────────────────────────
async function dsRenderComplete() {
    if (!_dsData) return;
    document.getElementById('ds-complete-name').textContent = _dsData.day_name;

    const streakResp = await fetch('/api/plugins/the_daily/streak');
    const streakText = await streakResp.text();
    const { streak } = streakText ? JSON.parse(streakText) : { streak: 0 };
    const streakEl = document.getElementById('ds-complete-streak');
    if (streak > 1) {
        streakEl.textContent = `🔥 ${streak}-day streak`;
    } else if (streak === 1) {
        streakEl.textContent = '🎯 First day of a new streak!';
    } else {
        streakEl.textContent = '';
    }

    const stored = localStorage.getItem(_dsSignKey(_dsData.date));
    if (stored) {
        try {
            const { name } = JSON.parse(stored);
            _dsSigned = true;
            document.getElementById('ds-sign-area').innerHTML =
                `<p class="text-green-400 text-sm">✓ Signed as <strong>${esc(name)}</strong></p>`;
        } catch {}
    }

    if (!_dsConfettiDone) {
        _dsConfettiDone = true;
        dsRunConfetti();
    }
}

// ── Rating selector ───────────────────────────────────────────────────────────
function dsSelectRating(val) {
    _dsRating = (_dsRating === val) ? null : val;
    [-1, 1, 2].forEach(v => {
        const btn = document.getElementById(`ds-rating-${v}`);
        const selected = _dsRating === v;
        btn.classList.toggle('ring-2', selected);
        btn.classList.toggle('ring-accent', selected);
        btn.classList.toggle('bg-accent/20', selected);
    });
}

// ── Sign leaderboard ──────────────────────────────────────────────────────────
async function dsSign() {
    if (_dsSigned || _dsSigning) return;
    const name = document.getElementById('ds-name-input').value.trim();
    const errEl = document.getElementById('ds-sign-error');
    errEl.classList.add('hidden');
    if (!name) { errEl.textContent = 'Enter your name.'; errEl.classList.remove('hidden'); return; }

    _dsSigning = true;
    try {
        const resp = await fetch('/api/plugins/the_daily/sign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ display_name: name, rating: _dsRating }),
        });
        const text = await resp.text();
        const result = text ? JSON.parse(text) : {};
        if (result.error) {
            errEl.textContent = result.error;
            errEl.classList.remove('hidden');
            return;
        }
        _dsSigned = true;
        if (_dsData?.date) {
            try {
                localStorage.setItem(_dsSignKey(_dsData.date), JSON.stringify({ name, rating: _dsRating }));
            } catch {}
        }
        document.getElementById('ds-sign-area').innerHTML =
            `<p class="text-green-400 text-sm">✓ Signed as <strong>${esc(name)}</strong></p>`;
        dsShowLeaderboard();
    } finally {
        _dsSigning = false;
    }
}

// ── Leaderboard view ──────────────────────────────────────────────────────────
async function dsShowLeaderboard() {
    dsShow('leaderboard');
    const resp = await fetch('/api/plugins/the_daily/leaderboard');
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};

    document.getElementById('ds-lb-day-name').textContent = data.day_name || '';
    document.getElementById('ds-lb-date').textContent = data.date
        ? new Date(data.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : '';

    const errEl = document.getElementById('ds-lb-error');
    if (data.error) {
        errEl.textContent = data.error;
        errEl.classList.remove('hidden');
    } else {
        errEl.classList.add('hidden');
    }

    const entries = data.entries || [];
    const ratings = data.ratings || {};
    const ratingIcon = { '-1': '👎', '1': '👍', '2': '🔥' };

    const ratingsEl = document.getElementById('ds-lb-ratings');
    const totalRated = Object.values(ratings).reduce((a, b) => a + b, 0);
    if (totalRated > 0) {
        ratingsEl.classList.remove('hidden');
        ratingsEl.innerHTML = [-1, 1, 2]
            .filter(v => ratings[v] > 0)
            .map(v => `<span>${ratingIcon[v]} <span class="text-white font-medium">${ratings[v]}</span></span>`)
            .join('');
    } else {
        ratingsEl.classList.add('hidden');
    }

    const container = document.getElementById('ds-lb-entries');
    if (entries.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm text-center py-8">No one has signed yet. Be the first!</p>';
    } else {
        container.innerHTML = entries.map((e, i) => {
            const time = e.completed_at
                ? new Date(e.completed_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                : '';
            const streak = e.streak > 1 ? `<span class="text-orange-400 text-xs">🔥 ${e.streak}-day streak</span>` : '';
            const rating = e.rating != null ? `<span class="text-lg">${ratingIcon[e.rating] || ''}</span>` : '';
            return `
                <div class="flex items-center gap-3 bg-dark-700/40 border border-gray-800/30 rounded-xl px-4 py-3">
                    <span class="text-xs text-gray-600 w-6 text-center flex-shrink-0">${i + 1}</span>
                    <span class="text-sm font-medium text-white flex-1">${esc(e.display_name)}</span>
                    ${streak}
                    ${rating}
                    <span class="text-xs text-gray-500 flex-shrink-0">${time}</span>
                </div>`;
        }).join('');
    }

    const countEl = document.getElementById('ds-lb-count');
    countEl.textContent = entries.length === 1
        ? '1 guitarist completed today'
        : `${entries.length} guitarists completed today`;
}

function dsShowSetlist() {
    dsShow(_dsData?.is_complete ? 'complete' : 'setlist');
}

// ── View switching ────────────────────────────────────────────────────────────
function dsShow(view) {
    ['loading', 'setlist', 'complete', 'leaderboard'].forEach(v => {
        document.getElementById(`ds-${v}`).classList.toggle('hidden', v !== view);
    });
}

function dsShowError(msg) {
    dsShow('setlist');
    document.getElementById('ds-songs').innerHTML =
        `<p class="text-red-400 text-sm py-8 text-center">${esc(msg)}</p>`;
}

// ── Confetti ──────────────────────────────────────────────────────────────────
function dsRunConfetti() {
    const canvas = document.getElementById('ds-confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#4080e0', '#60a0ff', '#e05050', '#e0a050', '#50c080', '#c050e0'];
    const particles = Array.from({ length: 80 }, () => ({
        x: Math.random() * canvas.width,
        y: -10 - Math.random() * 200,
        w: 8 + Math.random() * 10,
        h: 5 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 3,
        vy: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.15,
        alpha: 1,
    }));

    const start = performance.now();
    const duration = 3000;

    function frame(now) {
        const elapsed = now - start;
        const progress = elapsed / duration;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        let alive = false;
        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.08;
            p.rot += p.vrot;
            if (progress > 0.6) p.alpha = Math.max(0, 1 - (progress - 0.6) / 0.4);

            if (p.y < canvas.height + 20) alive = true;
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }

        if (alive && elapsed < duration + 500) {
            requestAnimationFrame(frame);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    requestAnimationFrame(frame);
}
