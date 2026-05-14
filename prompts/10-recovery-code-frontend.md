# Prompt 10 — Recovery code frontend (modal + settings + paste-to-restore)

## Goal

The user-facing surface for the recovery code: show-once modal on first launch ("here's your code, save it somewhere safe"), a settings entry to re-show it anytime, and a paste-to-restore flow that calls `/recovery-code/adopt`.

## Read first

- `plans/adr/0001-recovery-code-identity-and-local-primary-mirror.md`
- The existing show-once patterns in `screen.js` (e.g. how the rescan prompt or onboarding works)

## Pre-reqs

- Prompt 05 (recovery code backend) must have landed.
- Prompt 06 (Supabase mirror) ideally landed — adopt-restore wants the pull to work.

## Files allowed to touch

- `screen.js`
- `screen.html`

## Spec

### 1. Show-once modal on first launch

When the Daily screen renders for the first time on this install (no recovery code in `localStorage` mirror), call `/recovery-code` to fetch (auto-creates if missing), display in a modal:

```
┌──────────────────────────────────────────────────────────┐
│  Save your recovery code                                  │
├──────────────────────────────────────────────────────────┤
│  This code lets you restore your tokens, cosmetics,       │
│  and passport on a new install. Save it somewhere safe.   │
│                                                           │
│       forest-anchor-rapid-mint                            │
│                                                           │
│       [ Copy ]    [ I've saved it ]                       │
└──────────────────────────────────────────────────────────┘
```

Implementation:

```js
async function dsCheckRecoveryCode() {
    if (localStorage.getItem('ds_recovery_code_acked')) return;
    try {
        const r = await fetch(dsApiUrl('/api/plugins/the_daily/recovery-code'),
                              { headers: { 'X-Install-Id': dsInstallId() } });
        const data = await r.json();
        if (data.code) dsShowRecoveryCodeModal(data.code, /*firstTime*/ true);
    } catch (e) { /* silent — try again next session */ }
}

function dsShowRecoveryCodeModal(code, firstTime) {
    const modal = document.getElementById('ds-recovery-modal');
    modal.querySelector('.code-display').textContent = code;
    modal.querySelector('.first-time-only').style.display = firstTime ? '' : 'none';
    modal.classList.remove('hidden');
}

function dsAckRecoveryCode() {
    localStorage.setItem('ds_recovery_code_acked', '1');
    document.getElementById('ds-recovery-modal').classList.add('hidden');
}

function dsCopyRecoveryCode() {
    const code = document.querySelector('#ds-recovery-modal .code-display').textContent;
    navigator.clipboard.writeText(code);
    // Show a brief toast/checkmark
}
```

Call `dsCheckRecoveryCode()` when the Daily screen first becomes visible (hook into the existing `dsShowSetlist` / first-render path).

### 2. Settings entry — "Show recovery code"

Add a button somewhere in the existing Daily settings/profile UI (or in the nav as a small icon). Clicking it:

```js
async function dsShowRecoveryCodeFromSettings() {
    const r = await fetch(dsApiUrl('/api/plugins/the_daily/recovery-code'),
                          { headers: { 'X-Install-Id': dsInstallId() } });
    const data = await r.json();
    dsShowRecoveryCodeModal(data.code, /*firstTime*/ false);
}
```

### 3. Paste-to-restore flow

Add a second modal (or a tab on the recovery modal) for "I have a code from another install":

```
┌──────────────────────────────────────────────────────────┐
│  Restore from a recovery code                             │
├──────────────────────────────────────────────────────────┤
│  Paste your 4-word code below.                            │
│                                                           │
│   [ word - word - word - word                ]           │
│                                                           │
│   [ Restore ]                                             │
│                                                           │
│  ⚠ This will overwrite this install's progress.           │
└──────────────────────────────────────────────────────────┘
```

```js
async function dsAdoptRecoveryCode() {
    const input = document.getElementById('ds-recovery-input');
    const code = input.value.trim().toLowerCase();
    if (!/^[a-z]{3,8}(-[a-z]{3,8}){3}$/.test(code)) {
        // inline error: bad format
        input.classList.add('border-red-500');
        return;
    }
    if (!confirm('This overwrites this install\'s tokens, cosmetics, and stamps. Continue?')) return;
    const r = await fetch(dsApiUrl('/api/plugins/the_daily/recovery-code/adopt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
        body: JSON.stringify({ code }),
    });
    const data = await r.json();
    if (data.error) {
        // inline error
        return;
    }
    localStorage.setItem('ds_recovery_code_acked', '1');
    location.reload();  // simplest way to re-fetch all inventory
}
```

### 4. HTML

Add the two modals to `screen.html`. Match the existing modal styling (look at how rescan or completion modals are structured). Skeletons:

```html
<div id="ds-recovery-modal" class="hidden fixed inset-0 bg-black/60 flex items-center justify-center z-50">
  <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 max-w-md">
    <h2 class="text-lg font-semibold text-white mb-2">Your recovery code</h2>
    <p class="text-sm text-gray-400 mb-4 first-time-only">Save this somewhere safe...</p>
    <div class="code-display text-xl font-mono text-accent text-center py-4 mb-4 bg-dark-800 rounded-lg select-all"></div>
    <div class="flex gap-2">
      <button onclick="dsCopyRecoveryCode()" class="flex-1 px-4 py-2 rounded-xl bg-dark-600 hover:bg-dark-500 text-white text-sm">Copy</button>
      <button onclick="dsAckRecoveryCode()" class="flex-1 px-4 py-2 rounded-xl bg-accent hover:bg-accent-light text-white text-sm font-semibold">I've saved it</button>
    </div>
    <button onclick="document.getElementById('ds-recovery-restore-modal').classList.remove('hidden'); dsAckRecoveryCode()"
            class="mt-4 text-xs text-gray-500 hover:text-gray-300 underline w-full">
      I have a code from another install
    </button>
  </div>
</div>

<div id="ds-recovery-restore-modal" class="hidden ..."> ... </div>
```

### 5. Globals

Add to the existing `window.dsX = dsX` block:

```js
window.dsCheckRecoveryCode = dsCheckRecoveryCode;
window.dsShowRecoveryCodeFromSettings = dsShowRecoveryCodeFromSettings;
window.dsAckRecoveryCode = dsAckRecoveryCode;
window.dsCopyRecoveryCode = dsCopyRecoveryCode;
window.dsAdoptRecoveryCode = dsAdoptRecoveryCode;
```

(`onclick=` attributes need these on `window`.)

## Verification

```bash
node -c screen.js

# Manual:
# 1. Clear localStorage `ds_recovery_code_acked`. Reload Daily screen.
#    Modal should appear with a 4-word code.
# 2. Click "I've saved it." Modal closes. Reload — modal does NOT reappear.
# 3. Open settings entry / dev console: dsShowRecoveryCodeFromSettings()
#    Modal reappears with the same code.
# 4. Open the restore modal. Paste a different 4-word code that exists on Supabase.
#    Confirm. Page reloads. Inventory reflects the restored state.
# 5. Paste a malformed code ("not a code"). Should inline-error, not POST.
```

## Out of scope

- Do not re-implement the backend recovery endpoints — prompt 05 owns them.
- Do not implement Supabase pull on adopt — prompt 06 owns it. Frontend just calls `/adopt`.
- Do not add multi-device merge UI. Single-identity per ADR-0001.
- Do not auto-show the modal more than once. The `localStorage` flag is the gate.
- Do not add code rotation or expiry UI. Code is permanent until pasted-over.
