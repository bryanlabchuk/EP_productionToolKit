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
    themeSel: document.getElementById('theme-select'),
    editorTitle: document.getElementById('editor-title'),
    chordRoot: document.getElementById('chord-root')
};

// --- INITIALIZATION ---
async function initInterface() {
    // 1. RENDER VISUALS IMMEDIATELY (Do not wait for MIDI)
    initTheme();
    renderGroupTabs();
    renderPads(); // This draws the 12 pads
    populatePresets();
    
    // Select default pad to populate the editor/piano
    selectPad(0);

    // 2. Bind Global Controls
    document.getElementById('init-btn').onclick = () => engine.init();
    document.getElementById('transport-btn').onclick = toggleTransport;
    
    // Bind Input Listeners (BPM, Swing, etc)
    document.getElementById('tempo').onchange = (e) => engine.bpm = parseInt(e.target.value, 10);
    document.getElementById('swing-slider').oninput = (e) => engine.swing = parseInt(e.target.value, 10);
    document.getElementById('global-bars').onchange = (e) => engine.globalBars = parseInt(e.target.value, 10);
    
    // Bind Piano Keys (Mouse Clicks)
    document.querySelectorAll('.kb-key').forEach(k => {
        k.onmousedown = (e) => {
            const note = parseInt(k.getAttribute('data-note'), 10);
            updateChordRoot(note);
            e.preventDefault();
        };
    });

    log("VISUAL INTERFACE READY. CLICK INIT MIDI TO START.");

    // 3. Initialize Engine (Audio/MIDI) in background
    const ready = await engine.init();
    if (!ready) log("OFFLINE MODE (NO MIDI FOUND)");
    
    // 4. Setup Engine Callbacks (Visuals sync)
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
                renderPads(); // Re-render pads to show correct state for this group
                selectPad(selectedPad); // Refresh editor
                log(`GROUP ${['A','B','C','D'][i]} SELECTED`);
            };
        }
    }
}

function renderPads() {
    if (!ui.pads) return console.error("Pad Grid Element Missing!");
    ui.pads.innerHTML = '';
    
    const legends = { 9:'7', 10:'8', 11:'9', 6:'4', 7:'5', 8:'6', 3:'1', 4:'2', 5:'3', 0:'', 1:'0', 2:'ENTER' };
    
    // Visual Map: Top row (7,8,9), Middle (4,5,6)...
    const mapIdx = [9, 10, 11, 6, 7, 8, 3, 4, 5, 0, 1, 2];
    
    mapIdx.forEach(idx => {
        const btn = document.createElement('div');
        // Add specific classes for styling
        btn.className = 'pad-btn' + (idx === 0 ? ' pad-btn-sq' : '');
        
        // Highlight if selected
        if (idx === selectedPad) btn.classList.add('active-pad');
        
        btn.id = `pad-${idx}`;
        btn.innerHTML = `<div class="legend-tag">${legends[idx]}</div>`;
        
        // Select logic
        btn.onclick = () => selectPad(idx);
        
        // Play/Audition logic
        btn.onmousedown = (e) => {
            if(e.button === 0) { 
                triggerLivePad(idx);
            }
        };
        
        ui.pads.appendChild(btn);
    });
}

// Make selectPad globally available so HTML onclicks work if needed
window.selectPad = function(idx) {
    selectedPad = idx;
    
    // Visual Update: Highlight selected pad
    document.querySelectorAll('.pad-btn').forEach(b => b.classList.remove('active-pad'));
    const btn = document.getElementById(`pad-${idx}`);
    if(btn) btn.classList.add('active-pad');
    
    // Visual Update: Editor Title
    const l = idx === 0 ? '■' : idx;
    if(ui.editorTitle) ui.editorTitle.innerText = `EDIT: PAD ${l}`;
    
    // Visual Update: Editor Panels
    syncPadSettingsUI();
    renderSteps();
};

function selectPad(idx) { window.selectPad(idx); }

function renderSteps() {
    if (!ui.grid) return;
    ui.grid.innerHTML = '';
    const padData = engine.projectData[activeGroup][selectedPad];
    
    for(let i=0; i<FIXED_STEPS; i++) {
        const step = document.createElement('div');
        const val = padData.notes[i];
        
        step.className = `step-box ${val !== 'O' ? 'on-'+val.toLowerCase() : ''}`;
        step.innerText = val === 'O' ? '' : val;
        
        step.onmousedown = () => {
            const cycle = ['O', 'X', 'Y', 'Z'];
            padData.notes[i] = cycle[(cycle.indexOf(val) + 1) % cycle.length];
            renderSteps(); // Redraw
        };
        
        ui.grid.appendChild(step);
    }
}

// --- LOGIC INTERACTION ---

function triggerLivePad(padIdx) {
    const pad = engine.projectData[activeGroup][padIdx];
    const chan = activeGroup;
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

function flashPad(padIdx) {
    const btn = document.getElementById(`pad-${padIdx}`);
    if(btn) {
        btn.classList.add('hit');
        setTimeout(() => btn.classList.remove('hit'), 100);
    }
}

function log(msg) {
    if(!ui.lcd) return;
    const t = new Date().toLocaleTimeString().split(' ')[0];
    ui.lcd.innerHTML = `<div class="log-entry"><span style="opacity:0.5; margin-right:5px;">${t}</span>${msg}</div>` + ui.lcd.innerHTML;
}

// --- PRESETS ---

function populatePresets() {
    const sel = document.getElementById('preset-select');
    if(!sel) return;
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
    
    sel.onchange = (e) => {
        if(!e.target.value) return;
        loadPreset(JSON.parse(e.target.value));
        e.target.value = "";
    };
}

function loadPreset(preset) {
    if (preset.type === "multi") {
        for (const [idxStr, patStr] of Object.entries(preset.tracks)) {
            const idx = parseInt(idxStr);
            const cleanPat = patStr.replace(/\s/g, '');
            for(let i=0; i<64; i++) engine.projectData[activeGroup][idx].notes[i] = cleanPat[i % cleanPat.length];
        }
        log(`KIT LOADED: ${preset.name}`);
    } else {
        const pad = engine.projectData[activeGroup][selectedPad];
        const cleanPat = preset.pat.replace(/\s/g, '');
        for(let i=0; i<64; i++) pad.notes[i] = cleanPat[i % cleanPat.length];
        log(`PATTERN LOADED: ${preset.name}`);
    }
    renderSteps();
}

// --- SYNC UI TO DATA ---

function syncPadSettingsUI() {
    const pad = engine.projectData[activeGroup][selectedPad];
    
    // Performance Controls
    const elNote = document.getElementById('pad-midi-note');
    if(elNote) elNote.value = pad.midiNote;
    
    const elGate = document.getElementById('pad-gate-ms');
    if(elGate) elGate.value = pad.gateMs;
    
    const elVelMode = document.getElementById('pad-vel-mode');
    if(elVelMode) elVelMode.value = pad.velMode;
    
    const elVelA = document.getElementById('pad-vel-a');
    if(elVelA) elVelA.value = pad.velA;
    
    const elVelB = document.getElementById('pad-vel-b');
    if(elVelB) elVelB.value = pad.velB;
    
    // Chord Controls
    const elRoot = document.getElementById('chord-root');
    if(elRoot) elRoot.value = pad.chord.root;
    
    const elOct = document.getElementById('chord-oct');
    if(elOct) elOct.value = pad.chord.oct;
    
    const elQual = document.getElementById('chord-quality');
    if(elQual) elQual.value = pad.chord.quality;

    const elExt = document.getElementById('chord-ext');
    if(elExt) elExt.value = pad.chord.ext;

    const elInv = document.getElementById('chord-inv');
    if(elInv) elInv.value = pad.chord.inv;
    
    const elFlux = document.getElementById('chord-flux');
    if(elFlux) elFlux.value = pad.chord.flux;
    
    // Mode Buttons
    const isChord = pad.mode === 'chord';
    const btnDrum = document.getElementById('pad-mode-drum');
    const btnChord = document.getElementById('pad-mode-chord');
    
    if(btnDrum) btnDrum.classList.toggle('btn-toggle-on', !isChord);
    if(btnChord) btnChord.classList.toggle('btn-toggle-on', isChord);
    
    const chordLab = document.getElementById('chord-lab');
    if(chordLab) chordLab.style.display = isChord ? 'block' : 'none';
    
    if(ui.octaveDisp) ui.octaveDisp.innerText = pad.chord.oct;
    
    updatePianoVisuals(pad.chord);
}

// Expose these helpers to HTML
window.updatePadParam = (key, val) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad[key] = isNaN(val) ? val : parseInt(val, 10);
};

window.updateChordParam = (key, val) => {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.chord[key] = isNaN(val) ? val : parseInt(val, 10);
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

function updateChordRoot(noteIndex) {
    const pad = engine.projectData[activeGroup][selectedPad];
    pad.chord.root = noteIndex;
    if(ui.chordRoot) ui.chordRoot.value = noteIndex;
    updatePianoVisuals(pad.chord);
    triggerLivePad(selectedPad);
}

function updatePianoVisuals(chordData) {
    const root = chordData.root;
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

function initTheme() {
    const saved = localStorage.getItem('oxo_theme') || 'auto';
    if(ui.themeSel) ui.themeSel.value = saved;
    applyTheme(saved);
}

window.setThemeOverride = (val) => {
    localStorage.setItem('oxo_theme', val);
    applyTheme(val);
};

function applyTheme(t) {
    document.body.className = '';
    if(t !== 'auto') document.body.classList.add(`theme-${t}`);
}

window.toggleDark = () => { document.body.classList.toggle('dark-mode'); };

// START APP
initInterface();
