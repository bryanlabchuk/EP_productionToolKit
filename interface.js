import { SequencerEngine, PRESETS, FIXED_STEPS, clamp } from './engine.js';

const engine = new SequencerEngine();
let activeGroup = 0;
let selectedPad = 0;

const ui = {
    grid: document.getElementById('grid-notes'),
    pads: document.getElementById('pad-grid'),
    lcd: document.getElementById('log'),
    piano: document.getElementById('kb-keys'),
    octaveDisp: document.getElementById('octave-display'),
    tempo: document.getElementById('tempo'),
    themeSel: document.getElementById('theme-select')
};

async function initInterface() {
    const ready = await engine.init();
    if (!ready) log("OFFLINE MODE (NO MIDI)");
    
    engine.onLog = log;
    engine.onStepTrigger = (g, p, vel) => {
        if (g === activeGroup) flashPad(p);
    };
    engine.onClockTick = (stepIndex) => {
        document.querySelectorAll('.step-box').forEach((el, i) => {
            el.style.borderColor = (i === stepIndex) ? 'var(--accent)' : 'var(--text)';
        });
    };

    initTheme();
    renderGroupTabs();
    renderPads();
    selectPad(0);
    populatePresets();
    
    document.getElementById('init-btn').onclick = () => engine.init();
    document.getElementById('transport-btn').onclick = toggleTransport;
    
    document.getElementById('tempo').onchange = (e) => engine.bpm = parseInt(e.target.value, 10);
    document.getElementById('swing-slider').oninput = (e) => engine.swing = parseInt(e.target.value, 10);
    document.getElementById('global-bars').onchange = (e) => engine.globalBars = parseInt(e.target.value, 10);
    
    document.querySelectorAll('.kb-key').forEach(k => {
        k.onmousedown = (e) => {
            const note = parseInt(k.getAttribute('data-note'), 10);
            updateChordRoot(note);
            e.preventDefault();
        };
    });
    log("XOZY-EP INTERFACE READY");
}

function renderGroupTabs() {
    for(let i=0; i<4; i++) {
        const btn = document.getElementById(`grp-${i}`);
        if(btn) {
            btn.className = `group-btn ${i === activeGroup ? 'active' : ''}`;
            btn.onclick = () => {
                activeGroup = i;
                renderGroupTabs();
                renderPads();
                selectPad(selectedPad);
                log(`GROUP ${['A','B','C','D'][i]} SELECTED`);
            };
        }
    }
}

function renderPads() {
    ui.pads.innerHTML = '';
    const legends = { 9:'7', 10:'8', 11:'9', 6:'4', 7:'5', 8:'6', 3:'1', 4:'2', 5:'3', 0:'', 1:'0', 2:'ENTER' };
    
    // Original HTML order: 9,10,11 (Row 1), 6,7,8 (Row 2), etc.
    const mapIdx = [9, 10, 11, 6, 7, 8, 3, 4, 5, 0, 1, 2];
    
    mapIdx.forEach(idx => {
        const btn = document.createElement('div');
        btn.className = 'pad-btn' + (idx === 0 ? ' pad-btn-sq' : '');
        if (idx === selectedPad) btn.classList.add('active-pad');
        btn.id = `pad-${idx}`;
        
        btn.innerHTML = `<div class="legend-tag">${legends[idx]}</div>`;
        btn.onclick = () => selectPad(idx);
        btn.onmousedown = (e) => {
            if(e.button === 0) { // Left click only for audition
                triggerLivePad(idx);
            }
        };
        ui.pads.appendChild(btn);
    });
}

// Make selectPad globally available for HTML onclicks
window.selectPad = function(idx) {
    selectedPad = idx;
    document.querySelectorAll('.pad-btn').forEach(b => b.classList.remove('active-pad'));
    const btn = document.getElementById(`pad-${idx}`);
    if(btn) btn.classList.add('active-pad');
    
    const l = idx === 0 ? '■' : idx;
    document.getElementById('editor-title').innerText = `EDIT: PAD ${l}`;
    
    syncPadSettingsUI();
    renderSteps();
};

// Internal reference for interface logic
function selectPad(idx) { window.selectPad(idx); }

function renderSteps() {
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
            renderSteps();
        };
        ui.grid.appendChild(step);
    }
}

function triggerLivePad(padIdx) {
    const pad = engine.projectData[activeGroup][padIdx];
    const chan = activeGroup;
    if (engine.midiOut) {
        if(pad.mode === 'chord') engine.sendChord(pad, chan, 110, performance.now());
        else engine.sendMidiNote(chan, pad.midiNote, 110, pad.gateMs, performance.now());
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
    const t = new Date().toLocaleTimeString().split(' ')[0];
    ui.lcd.innerHTML = `<div class="log-entry"><span style="opacity:0.5; margin-right:5px;">${t}</span>${msg}</div>` + ui.lcd.innerHTML;
}

function populatePresets() {
    const sel = document.getElementById('preset-select');
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

function syncPadSettingsUI() {
    const pad = engine.projectData[activeGroup][selectedPad];
    
    document.getElementById('pad-midi-note').value = pad.midiNote;
    document.getElementById('pad-gate-ms').value = pad.gateMs;
    document.getElementById('pad-vel-mode').value = pad.velMode;
    document.getElementById('pad-vel-a').value = pad.velA;
    document.getElementById('pad-vel-b').value = pad.velB;
    
    document.getElementById('chord-root').value = pad.chord.root;
    document.getElementById('chord-oct').value = pad.chord.oct;
    document.getElementById('chord-quality').value = pad.chord.quality;
    document.getElementById('chord-ext').value = pad.chord.ext;
    document.getElementById('chord-inv').value = pad.chord.inv;
    document.getElementById('chord-voice').value = pad.chord.voice;
    document.getElementById('chord-flux').value = pad.chord.flux;
    
    const isChord = pad.mode === 'chord';
    document.getElementById('pad-mode-drum').classList.toggle('btn-toggle-on', !isChord);
    document.getElementById('pad-mode-chord').classList.toggle('btn-toggle-on', isChord);
    document.getElementById('chord-lab').style.display = isChord ? 'block' : 'none';
    
    ui.octaveDisp.innerText = pad.chord.oct;
    updatePianoVisuals(pad.chord);
}

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
    document.getElementById('chord-root').value = noteIndex;
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
    ui.themeSel.value = saved;
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

initInterface();
