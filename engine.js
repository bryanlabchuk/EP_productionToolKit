/* =========================================
   XOZY-EP ENGINE v2.0
   ========================================= */

export const FIXED_STEPS = 64;
const PAD_NOTES = [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47];

export function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// --- CHORD MATH ---
function getChordIntervals(quality, ext) {
    let intervals = [0];
    if (['min', 'dim'].includes(quality)) intervals.push(3);
    else if (quality === 'sus2') intervals.push(2);
    else if (quality === 'sus4') intervals.push(5);
    else intervals.push(4);

    if (quality === 'dim') intervals.push(6);
    else if (quality === 'aug') intervals.push(8);
    else intervals.push(7);

    if (ext !== 'none') {
        let seventh = (quality === 'maj' || quality === 'aug') ? 11 : 10;
        if (quality === 'dim') seventh = 9;
        intervals.push(seventh);
        if (['9', '11', '13'].includes(ext)) intervals.push(14);
        if (['11', '13'].includes(ext)) intervals.push(17);
        if (ext === '13') intervals.push(21);
        if (ext === '6') { intervals.pop(); intervals.push(9); }
    }
    return intervals;
}

function applyVoicing(intervals, voice) {
    if (voice === 'close') return intervals;
    let newInt = [...intervals];
    if (voice === 'wide' && newInt.length > 1) newInt[1] += 12;
    if (voice === 'open') {
        if (newInt.length > 1) newInt[1] += 12;
        if (newInt.length > 2) newInt[2] += 24;
    }
    return newInt;
}

function applyInversion(intervals, inv) {
    let newInt = [...intervals];
    for (let i = 0; i < inv; i++) {
        let n = newInt.shift();
        newInt.push(n + 12);
    }
    return newInt;
}

// --- ENGINE CLASS ---
export class SequencerEngine {
    constructor() {
        this.audioCtx = null;
        this.midiOut = null;
        this.isPlaying = false;
        this.nextNoteTime = 0.0;
        this.current16thNote = 0;
        this.timerID = null;
        this.scheduleAheadTime = 0.1;
        this.bpm = 120;
        this.swing = 0;
        this.humanize = false;
        this.sendTransport = true;
        this.suppressTransport = false;
        this.globalBars = 4;
        this.countIn = false;
        this.onStepTrigger = null;
        this.onClockTick = null;
        this.onLog = null;

        this.projectData = Array.from({ length: 4 }, () =>
            Array.from({ length: 12 }, (_, p) => ({
                steps: FIXED_STEPS,
                notes: Array(FIXED_STEPS).fill('O'),
                auto: Array(FIXED_STEPS).fill(0),
                autoTargetCC: 74,
                midiNote: PAD_NOTES[p] ?? 36,
                gateMs: 100,
                velMode: 'xyz',
                velA: 110,
                velB: 125,
                muted: false,
                mode: 'drum',
                chord: { root: 0, oct: 3, quality: 'maj', ext: 'none', inv: 0, voice: 'close', flux: 0 }
            }))
        );
    }

    log(msg) {
        if (this.onLog) this.onLog(msg);
        else console.log(msg);
    }

    async init() {
        try {
            if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
            if (!navigator.requestMIDIAccess) {
                this.log("ERR: WEBMIDI UNSUPPORTED");
                return false;
            }
            const m = await navigator.requestMIDIAccess({ sysex: false });
            const outs = Array.from(m.outputs.values());
            if (outs.length === 0) {
                this.log("ERR: NO MIDI OUTPUTS");
                return false;
            }
            const preferred = outs.find(o => {
                const n = (o.name || '').toLowerCase();
                return n.includes('ep-') || n.includes('teenage') || n.includes('op-') || n.includes('133');
            });
            this.midiOut = preferred || outs[0];
            this.log(`LINKED: ${(this.midiOut.name || 'UNKNOWN')}`);
            return true;
        } catch (e) {
            this.log(`ERR: ${e.message}`);
            return false;
        }
    }

    handleInject() {
        if (!this.midiOut || !this.audioCtx) return this.log("ERR: INIT MIDI");
        this.suppressTransport = true;
        if (this.countIn) this.runCountIn();
        else this.start();
    }

    runCountIn() {
        let b = 4;
        this.log(`COUNT: ${b}...`);
        const interval = setInterval(() => {
            b--;
            if (b > 0) this.log(`COUNT: ${b}...`);
            else {
                clearInterval(interval);
                this.log("GO!");
                this.start();
            }
        }, 60000 / this.bpm);
    }

    start() {
        this.stop();
        this.isPlaying = true;
        this.current16thNote = 0;
        this.nextNoteTime = this.audioCtx.currentTime + 0.1;
        if (this.midiOut && this.sendTransport && !this.suppressTransport) this.midiOut.send([0xFA]);
        this.log("ROLLING...");
        this.scheduler();
    }

    stop() {
        this.isPlaying = false;
        if (this.timerID) cancelAnimationFrame(this.timerID);
        if (this.midiOut) {
            if (this.sendTransport && !this.suppressTransport) this.midiOut.send([0xFC]);
            for (let ch = 0; ch < 4; ch++) this.midiOut.send([0xB0 + ch, 123, 0]);
        }
        this.suppressTransport = false;
        this.log("HALTED");
    }

    scheduler() {
        while (this.nextNoteTime < this.audioCtx.currentTime + this.scheduleAheadTime) {
            if (this.current16thNote >= this.globalBars * 16) {
                this.stop();
                this.log("COMPLETE");
                return;
            }
            this.scheduleNote(this.current16thNote, this.nextNoteTime);
            this.advanceNote();
        }
        if (this.isPlaying) this.timerID = requestAnimationFrame(() => this.scheduler());
    }

    advanceNote() {
        const secondsPer16th = (60.0 / this.bpm) * 0.25;
        this.nextNoteTime += secondsPer16th;
        this.current16thNote++;
    }

    scheduleNote(beatNumber, time) {
        if (this.midiOut) {
            const secondsPer16th = (60.0 / this.bpm) * 0.25;
            const pulseInterval = secondsPer16th / 6;
            for (let i = 0; i < 6; i++) {
                this.midiOut.send([0xF8], performance.now() + ((time + (i * pulseInterval)) - this.audioCtx.currentTime) * 1000);
            }
        }
        const isEven = (beatNumber % 2) !== 0;
        const swingDelay = isEven ? ((60 / this.bpm) / 4) * (this.swing / 100) : 0;
        const humanJitter = this.humanize ? (Math.random() * 0.015) : 0;
        const baseMidiTime = performance.now() + ((time + swingDelay + humanJitter) - this.audioCtx.currentTime) * 1000;

        for (let g = 0; g < 4; g++) {
            const chan = g;
            const noteOn = 0x90 + chan;
            const noteOff = 0x80 + chan;
            const ccStatus = 0xB0 + chan;

            for (let p = 0; p < 12; p++) {
                const pad = this.projectData[g][p];
                const stepIdx = beatNumber % FIXED_STEPS;
                const noteChar = pad.notes[stepIdx];
                const autoVal = pad.auto[stepIdx];

                if (autoVal > 0) this.midiOut.send([ccStatus, pad.autoTargetCC, autoVal], baseMidiTime);

                if (noteChar !== 'O' && !pad.muted) {
                    const velOut = this.computeVelocity(pad, noteChar);
                    if (pad.mode === 'chord') this.triggerChord(pad, chan, velOut, noteOn, noteOff, baseMidiTime);
                    else {
                        this.midiOut.send([noteOn, pad.midiNote, velOut], baseMidiTime);
                        this.midiOut.send([noteOff, pad.midiNote, 0], baseMidiTime + pad.gateMs);
                    }
                    if (this.onStepTrigger) setTimeout(() => this.onStepTrigger(g, p), (baseMidiTime - performance.now()));
                }
            }
        }
        if (this.onClockTick) setTimeout(() => this.onClockTick(beatNumber % FIXED_STEPS), (baseMidiTime - performance.now()));
    }

    computeVelocity(pad, stepChar) {
        let vel = stepChar === 'X' ? 120 : stepChar === 'Y' ? 85 : 50;
        if (pad.velMode === 'fixed') vel = pad.velA;
        else if (pad.velMode === 'range') {
            const lo = Math.min(pad.velA, pad.velB);
            const hi = Math.max(pad.velA, pad.velB);
            vel = lo + Math.floor(Math.random() * (hi - lo + 1));
        }
        return clamp(Math.round(vel), 1, 127);
    }

    triggerChord(pad, chan, vel, noteOn, noteOff, time) {
        let baseNote = (pad.chord.oct + 1) * 12 + pad.chord.root;
        let intervals = getChordIntervals(pad.chord.quality, pad.chord.ext);
        const fluxVal = pad.chord.flux / 100;
        let effectiveInv = pad.chord.inv;
        if (fluxVal > 0 && Math.random() < fluxVal) {
            if (Math.random() > 0.5) effectiveInv = (effectiveInv + 1) % 4;
            if (fluxVal > 0.6 && Math.random() > 0.8) baseNote += (Math.random() > 0.5 ? 12 : -12);
        }
        intervals = applyInversion(intervals, effectiveInv);
        intervals = applyVoicing(intervals, pad.chord.voice);

        intervals.forEach((interval, i) => {
            const noteNum = baseNote + interval;
            const strumDelay = i * (5 + (fluxVal * 20));
            const velVar = clamp(Math.round(vel + ((Math.random() - 0.5) * fluxVal * 40)), 1, 127);
            this.midiOut.send([noteOn, noteNum, velVar], time + strumDelay);
            this.midiOut.send([noteOff, noteNum, 0], time + strumDelay + pad.gateMs);
        });
    }
}

// --- FULL PRESETS ---
export const PRESETS = {
    "KICK (Single Pad)": [
        { name: "XOOO XOOO XOOO XOOO", pat: "XOOO XOOO XOOO XOOO" }, { name: "XOOX XOOX XOOX XOOX", pat: "XOOX XOOX XOOX XOOX" }, 
        { name: "XOOZ OOXZ OOOO XOOO", pat: "XOOZ OOXZ OOOO XOOO" }, { name: "XOOX OOZX OOZO OOXO", pat: "XOOX OOZX OOZO OOXO" }, 
        { name: "XOOO OOXZ XOOO OOXZ", pat: "XOOO OOXZ XOOO OOXZ" }, { name: "XOOO XXOO XOOO XXOO", pat: "XOOO XXOO XOOO XXOO" }, 
        { name: "XOOO OOOO OOOO OOOO", pat: "XOOO OOOO OOOO OOOO" }, { name: "XOOX OOOX XOOO OOOX", pat: "XOOX OOOX XOOO OOOX" }
    ],
    "SNARE (Single Pad)": [
        { name: "OOOO XOOO OOOO XOOO", pat: "OOOO XOOO OOOO XOOO" }, { name: "OOOO OOOO XOOO OOOO", pat: "OOOO OOOO XOOO OOOO" }, 
        { name: "OOOO YOOO ZZZZ YOOZ", pat: "OOOO YOOO ZZZZ YOOZ" }, { name: "OOZO YOOZ ZOZO YOOO", pat: "OOZO YOOZ ZOZO YOOO" }, 
        { name: "XOOX XOOX XOOX XXXX", pat: "XOOX XOOX XOOX XXXX" }, { name: "OOOO XOOO OOOO XOOZ", pat: "OOOO XOOO OOOO XOOZ" }
    ],
    "HATS (Single Pad)": [
        { name: "XOXO XOXO XOXO XOXO", pat: "XOXO XOXO XOXO XOXO" }, { name: "XXXX XXXX XXXX XXXX", pat: "XXXX XXXX XXXX XXXX" }, 
        { name: "OOXO OOXO OOXO OOXO", pat: "OOXO OOXO OOXO OOXO" }, { name: "XZXZ XZXZ XXXX XZXZ", pat: "XZXZ XZXZ XXXX XZXZ" }, 
        { name: "XZXZ XZXZ XZXZ ZZZZ", pat: "XZXZ XZXZ XZXZ ZZZZ" }, { name: "YXZY YXZY YXZY YXZY", pat: "YXZY YXZY YXZY YXZY" }, 
        { name: "XOOX XOOX XOOX XOOX", pat: "XOOX XOOX XOOX XOOX" }
    ],
    "ODD / EUCLIDEAN (Single)": [
        { name: "XOOX OOXO (3/8)", pat: "XOOX OOXO" }, { name: "XOXO XOXO (5/8)", pat: "XOXO XOXO" }, 
        { name: "XOOXOOXO (Tresillo)", pat: "XOOXOOXO" }, { name: "XOXOOXOO (Cinquillo)", pat: "XOXOOXOO" }, 
        { name: "XOOXOOXOOOXOOXOO (Bossa)", pat: "XOOXOOXOOOXOOXOO" }
    ],
    "FULL KITS (Pads 1-3)": [
        { name: "Basic House Kit", type: "multi", tracks: { 0:"XOOOXOOOXOOOXOOO", 1:"OOOOXOOOOOOOXOOO", 2:"OOXOOOXOOOXOOOXO" } }, 
        { name: "Deep House", type: "multi", tracks: { 0:"XOOOXOOXXOOOXOOX", 1:"OOOOXOOOOOOOXOOO", 2:"OOXOOOXOOOXOOOXO" } }, 
        { name: "Boom Bap 1", type: "multi", tracks: { 0:"XOOZOOXZOOOOXOOO", 1:"OOOOYOOOZZZZYOOZ", 2:"XOXOXOXOXOXOXOXO" } }, 
        { name: "Boom Bap 2", type: "multi", tracks: { 0:"XOOXOOZXOOZOOOXO", 1:"OOOOXOOOZOOOXOOZ", 2:"XZXZXZXZXZXZXZXZ" } }, 
        { name: "Rock Beat 1", type: "multi", tracks: { 0:"XOOOXXOOXOOOXXOO", 1:"OOOOXOOOOOOOXOOO", 2:"XXXXXOXOXXXXXOXO" } }, 
        { name: "Punk Drive", type: "multi", tracks: { 0:"XOOOXOOOXOOOXOOO", 1:"OOOOXOOOOOOOXOOO", 2:"XXXXXXXXXXXXXXXX" } }, 
        { name: "Dem Bow Kit", type: "multi", tracks: { 0:"XOOOXOOOXOOOXOOO", 1:"OOXZOOXZOOXZOOXZ", 2:"XXXXXXXXXXXXXXXX" } }, 
        { name: "Trap Banger", type: "multi", tracks: { 0:"XOOOOOOOXOOOOOOO", 1:"OOOOOOOOXOOOOOOO", 2:"XZXZXZXZXXXXXZXZ" } }
    ]
};
