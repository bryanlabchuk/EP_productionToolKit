/* =========================================
   XOZY-EP INTERFACE (UI & Events)
   ========================================= */

import { SequencerEngine, PRESETS, FIXED_STEPS, clamp } from './engine.js';

// --- STATE ---
const engine = new SequencerEngine();
let activeGroup = 0; // 0=A, 1=B, 2=C, 3=D
let selectedPad = 0; // 0-11

// --- DOM CACHE ---
const ui = {
    grid: document.getElementById('grid-notes'),
    pads: document.getElementById('pad-grid'),
    lcd: document.getElementById('log'),
    piano: document.getElementById('kb-keys'),
    octaveDisp: document.getElementById('octave-display'),
    tempo: document.getElementById('tempo'),
    editorTitle: document.getElementById('editor-title'),
    chordRoot: document.getElementById('chord-root'),
    // NEW:
    kitSel: document.getElementById('preset-kit-select'),
    padSel: document.getElementById('preset-pad-select')
};

// --- INITIALIZATION ---
async function initInterface() {
    // 1. Setup UI visuals immediately
    initTheme();
    renderGroupTabs();
    renderPads();
    populatePresets();
    selectPad(0);

    // 2. Bind Global Buttons
    document.getElementById('init-btn').onclick = () => initEngine();
    document.getElementById('transport-btn').onclick = toggleTransport;
    
    // 3. Bind Global Inputs
    document.getElementById('tempo').onchange = (e) => engine.bpm = parseInt(e.target.value, 10);
    document.getElementById('swing-slider').oninput = (e) => engine.swing = parseInt(e.target.value, 10);
    document.getElementById('global-bars').onchange = (e) => engine.globalBars = parseInt(e.target.value, 10);

    // 4. Bind Piano Visuals
    document.querySelectorAll('.kb-key').forEach(k => {
        k.onmousedown = (e) => {
            const note = parseInt(k.getAttribute('data-note'), 10);
            updateChordRoot(note);
            e.preventDefault();
        };
    });

    log("INTERFACE READY. PLEASE INITIALIZE MIDI.");
}

async function initEngine() {
    const ready = await engine.init();
    if (!ready) {
        log("OFFLINE MODE (NO MIDI FOUND)");
        return;
    }

    // Connect Engine Callbacks to UI
    engine.onLog = log;
    
    engine.onStepTrigger = (g, p, vel) => {
        if (g === activeGroup) flashPad(p);
    };
    
    engine.onClockTick = (stepIndex) => {
        // Highlight the current column in the grid
        const steps = document.querySelectorAll('.step-box');
        steps.forEach((el, i) => {
            el.style.borderColor = (i === stepIndex) ? 'var(--accent)' : 'var(--text)';
            el.style.opacity = (i === stepIndex) ? '1' : '';
        });
    };

    document.getElementById('init-btn').innerText = "LINKED";
    document.getElementById('init-btn').classList.add('active');
}

// --- RENDERING ---

function renderGroupTabs() {
    for (let i = 0; i < 4; i++) {
        const btn = document.getElementById(`grp-${i}`);
        if (btn) {
            btn.className = `group-btn ${i === activeGroup ? 'active' : ''}`;
            btn.onclick = () => {
                activeGroup = i;
                renderGroupTabs();
                // Refresh views
                syncPadSettingsUI(); 
                renderSteps();
                log(`GROUP ${['A', 'B', 'C', 'D'][i]} SELECTED`);
            };
        }
    }
}

function renderPads() {
    if (!ui.pads) return;
    ui.pads.innerHTML = '';

    const legends = { 9: '7', 10: '8', 11: '9', 6: '4', 7: '5', 8: '6', 3: '1', 4: '2', 5: '3', 0: '', 1: '0', 2: 'ENTER' };
    // Map visual layout (7-8-9 top row) to data indices
    const mapIdx = [9, 10, 11, 6, 7, 8, 3, 4, 5, 0, 1, 2];

    mapIdx.forEach(idx => {
        const btn = document.createElement('div');
        btn.className = 'pad-btn' + (idx === 0 ? ' pad-btn-sq' : '');
        btn.id = `pad-${idx}`;
        if (idx === selectedPad) btn.classList.add('active-pad');

        btn.innerHTML = `<div class="legend-tag">${legends[idx]}</div>`;
        
        // Select on click
        btn.onclick = () => selectPad(idx);
        
        // Trigger on press
        btn.onmousedown = (e) => {
            if (e.button === 0) triggerLivePad(idx);
        };

        ui.pads.appendChild(btn);
    });
}

function renderSteps() {
    if (!ui.grid) return;
    ui.grid.innerHTML = '';
    const padData = engine.projectData[activeGroup][selectedPad];

    for (let i = 0; i < FIXED_STEPS; i++) {
        const step = document.createElement('div');
        const val = padData.notes[i];

        step.className = `step-box ${val !== 'O' ? 'on-' + val.toLowerCase() : ''}`;
        step.innerText = val === 'O' ? '' : val;

        step.onmousedown = () => {
            // Cycle O -> X -> Y -> Z -> O
            const cycle = ['O', 'X', 'Y', 'Z'];
            padData.notes[i] = cycle[(cycle.indexOf(val) + 1) % cycle.length];
            renderSteps();
        };

        ui.grid.appendChild(step);
    }
}

// --- INTERACTION LOGIC ---

function selectPad(idx) {
    selectedPad = idx;

    // Visuals
    document.querySelectorAll('.pad-btn').forEach(b => b.classList.remove('active-pad'));
    const btn = document.getElementById(`pad-${idx}`);
    if (btn) btn.classList.add('active-pad');

    const l = idx === 0 ? '■' : idx;
    if (ui.editorTitle) ui.editorTitle.innerText = `EDIT: PAD ${l}`;

    syncPadSettingsUI();
    renderSteps();
}

function triggerLivePad(padIdx) {
    const pad = engine.projectData[activeGroup][padIdx];
    const chan = activeGroup;
    
    // Direct passthrough to engine logic
    if (engine.midiOut) {
        if (pad.mode === 'chord') {
            engine.triggerChord(pad, chan, 110, 0x90+chan, 0x80+chan, performance.now());
        } else {
            engine.sendMidiNote(chan, pad.midiNote, 110, pad.gateMs, performance.now());
        }
    }
    flashPad(padIdx);
}

function toggleTransport() {
    if (engine.isPlaying) {
        engine.stop();
        document.getElementById('transport-btn').innerText = "TX: START";
        document.getElementById('transport-btn').classList.remove('btn-toggle-on');
    } else {
        engine.start();
        document.getElementById('transport-btn').innerText = "TX: STOP";
        document.getElementById('transport-btn').classList.add('btn-toggle-on');
    }
}

function flashPad(padIdx) {
    const btn = document.getElementById(`pad-${padIdx}`);
    if (btn) {
        btn.classList.add('hit');
        setTimeout(() => btn.classList.remove('hit'), 100);
    }
}

function log(msg) {
    if (!ui.lcd) return;
    const t = new Date().toLocaleTimeString().split(' ')[0];
    ui.lcd.innerHTML = `<div class="log-entry"><span style="opacity:0.5; margin-right:5px;">${t}</span>${msg}</div>` + ui.lcd.innerHTML;
}

// --- PRESETS & SETTINGS ---

function populatePresets() {
    if (!ui.kitSel || !ui.padSel) return;

    // Reset menus
    ui.kitSel.innerHTML = '<option value="">-- LOAD KIT --</option>';
    ui.padSel.innerHTML = '<option value="">-- LOAD PATTERN --</option>';

    for (const [category, patterns] of Object.entries(PRESETS)) {
        // Create the group (optgroup)
        const group = document.createElement('optgroup');
        group.label = category;

        patterns.forEach(pat => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify(pat);
            opt.innerText = pat.name;
            group.appendChild(opt);
        });

        // SORTING LOGIC:
        // If the category name contains "KIT" or it's a multi-track preset, goes to Left Menu.
        // Otherwise, it goes to Right Menu.
        const isKit = category.toUpperCase().includes('KIT') || (patterns[0] && patterns[0].type === 'multi');

        if (isKit) {
            ui.kitSel.appendChild(group);
        } else {
            ui.padSel.appendChild(group);
        }
    }

    // Bind Event Listeners
    ui.kitSel.onchange = (e) => {
        if (!e.target.value) return;
        loadPreset(JSON.parse(e.target.value));
        e.target.value = ""; // Reset dropdown after selection
    };

    ui.padSel.onchange = (e) => {
        if (!e.target.value) return;
        loadPreset(JSON.parse(e.target.value));
        e.target.value = ""; // Reset dropdown
    };
}

function loadPreset(preset) {
    if (preset.type === "multi") {
        for (const [idxStr, patStr] of Object.entries(preset.tracks)) {
            const idx = parseInt(idxStr);
            const cleanPat = patStr.replace(/\s/g, '');
            for (let i = 0; i < 64; i++) {
                engine.projectData[activeGroup][idx].notes[i] = cleanPat[i % cleanPat.length];
            }
        }
        log(`KIT LOADED: ${preset.name}`);
    } else {
        const pad = engine.projectData[activeGroup][selectedPad];
        const cleanPat = preset.pat.replace(/\s/g, '');
        for (let i = 0; i < 64; i++) {
            pad.notes[i] = cleanPat[i % cleanPat.length];
        }
        log(`PATTERN LOADED: ${preset.name}`);
    }
    renderSteps();
}

function syncPadSettingsUI() {
    const pad = engine.projectData[activeGroup][selectedPad];

    // Sync inputs safely
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };

    setVal('pad-midi-note', pad.midiNote);
    setVal('pad-gate-ms', pad.gateMs);
    setVal('pad-vel-mode', pad.velMode);
    setVal('pad-vel-a', pad.velA);
    setVal('pad-vel-b', pad.velB);
    setVal('pad-auto-cc', pad.autoTargetCC);

    setVal('chord-root', pad.chord.root);
    setVal('chord-oct', pad.chord.oct);
    setVal('chord-quality', pad.chord.quality);
    setVal('chord-ext', pad.chord.ext);
    setVal('chord-inv', pad.chord.inv);
    setVal('chord-voice', pad.chord.voice);
    setVal('chord-flux', pad.chord.flux);

    // Mute Button
    const muteBtn = document.getElementById('pad-mute-btn');
    if (muteBtn) {
        muteBtn.classList.toggle('btn-toggle-on', pad.muted);
        muteBtn.innerText = pad.muted ? 'PAD: MUTE' : 'PAD: ON';
    }

    // Mode Buttons
    const isChord = pad.mode === 'chord';
    document.getElementById('pad-mode-drum').classList.toggle('btn-toggle-on', !isChord);
    document.getElementById('pad-mode-chord').classList.toggle('btn-toggle-on', isChord);
    
    // Show/Hide Piano
    const chordLab = document.getElementById('chord-lab');
    if (chordLab) chordLab.style.display = isChord ? 'block' : 'none';

    if (ui.octaveDisp) ui.octaveDisp.innerText = pad.chord.oct;
    updatePianoVisuals(pad.chord);
}

// --- PIANO LOGIC ---

function updateChordRoot(noteIndex) {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.chord.root = noteIndex;
    if (ui.chordRoot) ui.chordRoot.value = noteIndex;
    updatePianoVisuals(pad.chord);
    triggerLivePad(selectedPad); // Preview
}

function updatePianoVisuals(chordData) {
    const root = chordData.root;
    document.querySelectorAll('.kb-key').forEach(k => {
        k.classList.remove('is-root');
        if (parseInt(k.getAttribute('data-note')) === root) k.classList.add('is-root');
    });
}

function initTheme() {
    const saved = localStorage.getItem('oxo_theme') || 'auto';
    if (ui.themeSel) ui.themeSel.value = saved;
    applyTheme(saved);
}

function applyTheme(t) {
    document.body.className = ''; // reset
    if (t !== 'auto') document.body.classList.add(`theme-${t}`);
}

// --- WINDOW EXPORTS (For HTML onclick attributes) ---

window.selectGroup = (idx) => {
    activeGroup = idx;
    renderGroupTabs();
    // Re-select current pad index to refresh data for new group
    selectPad(selectedPad);
    log(`GROUP ${['A','B','C','D'][idx]} SELECTED`);
};

window.selectPad = (idx) => selectPad(idx);

window.toggleLayout = () => {
    document.getElementById('app-chassis').classList.toggle('skinny-mode');
};

window.toggleDark = () => {
    document.body.classList.toggle('dark-mode');
    localStorage.setItem('oxo_dark', document.body.classList.contains('dark-mode'));
};

window.setThemeOverride = (val) => {
    localStorage.setItem('oxo_theme', val);
    applyTheme(val);
};

window.initAudioAndMIDI = () => initEngine(); // Mapping old button name to new func

window.updatePadPerfFromUI = () => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.midiNote = parseInt(document.getElementById('pad-midi-note').value, 10);
    pad.gateMs = parseInt(document.getElementById('pad-gate-ms').value, 10);
    pad.velMode = document.getElementById('pad-vel-mode').value;
    pad.velA = parseInt(document.getElementById('pad-vel-a').value, 10);
    pad.velB = parseInt(document.getElementById('pad-vel-b').value, 10);
    pad.autoTargetCC = parseInt(document.getElementById('pad-auto-cc').value, 10);
    
    document.getElementById('pad-note-preview').innerText = pad.midiNote;
};

window.togglePadMute = () => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.muted = !pad.muted;
    syncPadSettingsUI();
};

window.resetPadPerf = () => {
    // We assume default note map 36-47
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.midiNote = 36 + selectedPad; 
    pad.gateMs = 100;
    pad.velMode = 'xyz';
    pad.velA = 110;
    pad.velB = 125;
    pad.muted = false;
    syncPadSettingsUI();
};

window.setPadMode = (mode) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.mode = mode;
    syncPadSettingsUI();
};

window.shiftOctave = (dir) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.chord.oct = clamp(pad.chord.oct + dir, 1, 6);
    syncPadSettingsUI();
};

window.updateChordSettings = () => {
    const pad = engine.projectData[activeGroup][selectedPad];
    // Root is handled by piano click, but other params via change
    pad.chord.quality = document.getElementById('chord-quality').value;
    pad.chord.ext = document.getElementById('chord-ext').value;
    pad.chord.inv = parseInt(document.getElementById('chord-inv').value, 10);
    pad.chord.voice = document.getElementById('chord-voice').value;
    pad.chord.flux = parseInt(document.getElementById('chord-flux').value, 10);
    
    // Preview changes if in chord mode
    if(pad.mode === 'chord') triggerLivePad(selectedPad);
};

window.applyPreset = (val) => {
    if(!val) return;
    loadPreset(JSON.parse(val));
    document.getElementById('preset-select').value = "";
};

window.clearCurrentPad = () => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.notes.fill('O');
    renderSteps();
};

window.handleInject = () => engine.handleInject();
window.toggleCountIn = () => engine.countIn = !engine.countIn; // Simple toggle
window.toggleHuman = () => engine.humanize = !engine.humanize;
window.stopSequencer = () => engine.stop();

// --- START ---
initInterface();
