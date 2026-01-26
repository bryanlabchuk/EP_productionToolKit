import { SequencerEngine, PRESETS, FIXED_STEPS, clamp } from './engine.js';

// --- GLOBAL STATE ---
const engine = new SequencerEngine();
let activeGroup = 0; // 0=A, 1=B, 2=C, 3=D
let selectedPad = 0; // 0-11

// --- DOM ELEMENTS ---
const ui = {
    grid: document.getElementById('grid-notes'),
    pads: document.getElementById('pad-grid'),
    lcd: document.getElementById('log'),
    piano: document.getElementById('kb-keys'),
    octaveDisp: document.getElementById('octave-display'),
    tempo: document.getElementById('tempo'),
    themeSel: document.getElementById('theme-select')
};

// --- INITIALIZATION ---
async function initInterface() {
    // 1. Initialize Engine (Audio/MIDI)
    const ready = await engine.init();
    if (!ready) log("OFFLINE MODE (NO MIDI)");
    
    // 2. Setup Engine Callbacks (Visuals)
    engine.onLog = log;
    engine.onStepTrigger = (g, p, vel) => {
        if (g === activeGroup) flashPad(p);
    };
    engine.onClockTick = (stepIndex) => {
        // Highlight current step column
        document.querySelectorAll('.step-box').forEach((el, i) => {
            el.style.borderColor = (i === stepIndex) ? 'var(--accent)' : 'var(--text)';
        });
    };

    // 3. Render Initial UI
    initTheme();
    renderGroupTabs();
    renderPads();
    selectPad(0);
    populatePresets();
    
    // 4. Bind Global Controls
    document.getElementById('init-btn').onclick = () => engine.init();
    document.getElementById('transport-btn').onclick = toggleTransport;
    
    // Bind Input Listeners (BPM, Swing, etc)
    document.getElementById('tempo').onchange = (e) => engine.bpm = parseInt(e.target.value, 10);
    document.getElementById('swing-slider').oninput = (e) => engine.swing = parseInt(e.target.value, 10);
    document.getElementById('global-bars').onchange = (e) => engine.globalBars = parseInt(e.target.value, 10);
    
    // Bind Piano Keys
    document.querySelectorAll('.kb-key').forEach(k => {
        k.onmousedown = (e) => {
            const note = parseInt(k.getAttribute('data-note'), 10);
            updateChordRoot(note);
            e.preventDefault();
        };
    });

    log("XOZY-EP INTERFACE READY");
}

// --- CORE RENDERING ---

function renderGroupTabs() {
    for(let i=0; i<4; i++) {
        const btn = document.getElementById(`grp-${i}`);
        if(btn) {
            btn.className = `group-btn ${i === activeGroup ? 'active' : ''}`;
            btn.onclick = () => {
                activeGroup = i;
                renderGroupTabs();
                renderPads();
                selectPad(selectedPad); // Refresh editor
                log(`GROUP ${['A','B','C','D'][i]} SELECTED`);
            };
        }
    }
}

function renderPads() {
    ui.pads.innerHTML = '';
    const legends = { 9:'7', 10:'8', 11:'9', 6:'4', 7:'5', 8:'6', 3:'1', 4:'2', 5:'3', 0:'', 1:'0', 2:'ENTER' };
    
    for(let i=0; i<12; i++) {
        // Mapping visual grid (7-8-9 layout) to index 0-11
        // The HTML layout was: row1(9,10,11), row2(6,7,8)...
        // We stick to the standard index 0-11 for data
        const mapIdx = [9, 10, 11, 6, 7, 8, 3, 4, 5, 0, 1, 2][i];
        
        const btn = document.createElement('div');
        btn.className = 'pad-btn' + (mapIdx === 0 ? ' pad-btn-sq' : '');
        if (mapIdx === selectedPad) btn.classList.add('active-pad');
        btn.id = `pad-${mapIdx}`;
        
        btn.innerHTML = `<div class="legend-tag">${legends[mapIdx]}</div>`;
        
        // Select
        btn.onclick = () => selectPad(mapIdx);
        
        // Audition (Play Live)
        btn.onmousedown = (e) => {
            triggerLivePad(mapIdx);
            e.preventDefault(); // Prevent focus theft
        };
        
        ui.pads.appendChild(btn);
    }
}

function selectPad(idx) {
    selectedPad = idx;
    
    // Highlight UI
    document.querySelectorAll('.pad-btn').forEach(b => b.classList.remove('active-pad'));
    const btn = document.getElementById(`pad-${idx}`);
    if(btn) btn.classList.add('active-pad');
    
    // Update Title
    const l = idx === 0 ? '■' : idx;
    document.getElementById('editor-title').innerText = `EDIT: PAD ${l}`;
    
    // Update Editor Panels
    syncPadSettingsUI();
    renderSteps();
}

function renderSteps() {
    ui.grid.innerHTML = '';
    const padData = engine.projectData[activeGroup][selectedPad];
    
    for(let i=0; i<FIXED_STEPS; i++) {
        const step = document.createElement('div');
        const val = padData.notes[i];
        
        // Style based on value (X=High, Y=Med, Z=Low, O=Off)
        step.className = `step-box ${val !== 'O' ? 'on-'+val.toLowerCase() : ''}`;
        step.innerText = val === 'O' ? '' : val;
        
        step.onmousedown = () => {
            // Cycle: O -> X -> Y -> Z -> O
            const cycle = ['O', 'X', 'Y', 'Z'];
            const next = cycle[(cycle.indexOf(val) + 1) % cycle.length];
            padData.notes[i] = next;
            renderSteps(); // Re-render to show change
        };
        
        ui.grid.appendChild(step);
    }
}

// --- LOGIC INTERACTION ---

function triggerLivePad(padIdx) {
    // We manually construct a trigger to send to the engine or MIDI directly
    // Since engine handles logic, let's ask it to fire a specific note
    const pad = engine.projectData[activeGroup][padIdx];
    const chan = activeGroup;
    
    // Use engine's internal methods (We assume engine exposes sendMidiNote/sendChord)
    // For this specific interaction, we replicate the logic slightly for responsiveness
    if (engine.midiOut) {
        if(pad.mode === 'chord') {
            engine.sendChord(pad, chan, 110, performance.now());
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

// --- UI HELPERS ---

function flashPad(padIdx) {
    const btn = document.getElementById(`pad-${padIdx}`);
    if(btn) {
        btn.classList.add('hit');
        setTimeout(() => btn.classList.remove('hit'), 100);
    }
}

function log(msg) {
    const t = new Date().toLocaleTimeString().split(' ')[0];
    const entry = `<div class="log-entry"><span style="opacity:0.5; margin-right:5px;">${t}</span>${msg}</div>`;
    ui.lcd.innerHTML = entry + ui.lcd.innerHTML;
}

// --- PRESETS & SETTINGS ---

function populatePresets() {
    const sel = document.getElementById('preset-select');
    // Clear existing
    sel.innerHTML = '<option value="">-- LOAD PRESET --</option>';
    
    for (const [category, patterns] of Object.entries(PRESETS)) {
        const group = document.createElement('optgroup');
        group.label = category;
        patterns.forEach(pat => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify(pat);
            opt.innerText = pat.name;
            group.appendChild(opt);
        });
        sel.appendChild(group);
    }
    
    // Bind Event
    sel.onchange = (e) => {
        if(!e.target.value) return;
        loadPreset(JSON.parse(e.target.value));
        e.target.value = ""; // Reset dropdown
    };
}

function loadPreset(preset) {
    const pad = engine.projectData[activeGroup][selectedPad];
    
    if (preset.type === "multi") {
        // Load Kit (Pads 0, 1, 2...)
        for (const [idxStr, patStr] of Object.entries(preset.tracks)) {
            const idx = parseInt(idxStr);
            const cleanPat = patStr.replace(/\s/g, '');
            for(let i=0; i<64; i++) {
                engine.projectData[activeGroup][idx].notes[i] = cleanPat[i % cleanPat.length];
            }
        }
        log(`KIT LOADED: ${preset.name}`);
    } else {
        // Single Pad
        const cleanPat = preset.pat.replace(/\s/g, '');
        for(let i=0; i<64; i++) {
            pad.notes[i] = cleanPat[i % cleanPat.length];
        }
        log(`PATTERN LOADED: ${preset.name}`);
    }
    renderSteps();
}

// --- CHORD & PARAMS UI (Syncing Inputs) ---

function syncPadSettingsUI() {
    const pad = engine.projectData[activeGroup][selectedPad];
    
    // Sync Inputs
    document.getElementById('pad-midi-note').value = pad.midiNote;
    document.getElementById('pad-gate-ms').value = pad.gateMs;
    document.getElementById('pad-vel-mode').value = pad.velMode;
    document.getElementById('pad-vel-a').value = pad.velA;
    document.getElementById('pad-vel-b').value = pad.velB;
    
    // Sync Chord UI
    document.getElementById('chord-root').value = pad.chord.root;
    document.getElementById('chord-oct').value = pad.chord.oct;
    document.getElementById('chord-quality').value = pad.chord.quality;
    document.getElementById('chord-ext').value = pad.chord.ext;
    document.getElementById('chord-inv').value = pad.chord.inv;
    document.getElementById('chord-voice').value = pad.chord.voice;
    document.getElementById('chord-flux').value = pad.chord.flux;
    
    // Sync Mode Buttons
    const isChord = pad.mode === 'chord';
    document.getElementById('pad-mode-drum').classList.toggle('btn-toggle-on', !isChord);
    document.getElementById('pad-mode-chord').classList.toggle('btn-toggle-on', isChord);
    document.getElementById('chord-lab').style.display = isChord ? 'block' : 'none';
    
    ui.octaveDisp.innerText = pad.chord.oct;
    updatePianoVisuals(pad.chord);
}

// Expose these helpers to HTML onchange events
window.updatePadParam = (key, val) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad[key] = isNaN(val) ? val : parseInt(val, 10);
};

window.updateChordParam = (key, val) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.chord[key] = isNaN(val) ? val : parseInt(val, 10);
    // If updating octave or root, refresh visual piano
    if(key === 'root' || key === 'oct') updatePianoVisuals(pad.chord);
};

window.setPadMode = (mode) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.mode = mode;
    syncPadSettingsUI();
};

window.clearCurrentPad = () => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.notes.fill('O');
    renderSteps();
    log("PATTERN CLEARED");
};

// --- PIANO VISUALS ---
function updateChordRoot(noteIndex) {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.chord.root = noteIndex;
    document.getElementById('chord-root').value = noteIndex;
    updatePianoVisuals(pad.chord);
    // Preview
    triggerLivePad(selectedPad);
}

function updatePianoVisuals(chordData) {
    const root = chordData.root;
    // Simple visual: Highlight root. 
    // (Full chord highlighting requires importing the math from engine, 
    // or moving that math to a shared utility file. For now, we highlight root).
    document.querySelectorAll('.kb-key').forEach(k => {
        k.classList.remove('is-root');
        if (parseInt(k.getAttribute('data-note')) === root) k.classList.add('is-root');
    });
}

window.shiftOctave = (dir) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.chord.oct = clamp(pad.chord.oct + dir, 1, 6);
    syncPadSettingsUI();
};

// --- THEME ---
function initTheme() {
    const saved = localStorage.getItem('oxo_theme') || 'auto';
    ui.themeSel.value = saved;
    applyTheme(saved);
}

window.setThemeOverride = (val) => {
    localStorage.setItem('oxo_theme', val);
    applyTheme(val);
};

function applyTheme(t) {
    document.body.className = ''; // clear
    if(t !== 'auto') document.body.classList.add(`theme-${t}`);
    // If auto, we'd check MIDI device name in Engine, but simplified here
}

window.toggleDark = () => {
    document.body.classList.toggle('dark-mode');
};

// --- BOOT ---
initInterface();
