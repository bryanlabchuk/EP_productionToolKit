/* --- CONSTANTS & HELPERS --- */
export const FIXED_STEPS = 64;
// Standard MIDI note map for pads 0-11
export const PAD_NOTES = [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47];

// Pure Math Helpers
export function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// Chord Logic (Pure Math)
function getChordIntervals(quality, ext) {
    let intervals = [0];
    if (['min', 'dim'].includes(quality)) intervals.push(3);
    else if (quality === 'sus2') intervals.push(2);
    else if (quality === 'sus4') intervals.push(5);
    else intervals.push(4); // Major 3rd

    if (quality === 'dim') intervals.push(6);
    else if (quality === 'aug') intervals.push(8);
    else intervals.push(7); // Perfect 5th

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
    for (let i=0; i<inv; i++) { 
        let n = newInt.shift(); 
        newInt.push(n + 12); 
    }
    return newInt;
}

/* --- THE ENGINE CLASS --- */
export class SequencerEngine {
    constructor() {
        this.audioCtx = null;
        this.midiOut = null;
        this.isPlaying = false;
        
        // Timing
        this.nextNoteTime = 0.0;
        this.current16thNote = 0;
        this.timerID = null;
        this.scheduleAheadTime = 0.1;
        this.bpm = 120;
        
        // Parameters
        this.swing = 0;
        this.humanize = false;
        this.sendTransport = true;
        this.suppressTransport = false;
        this.globalBars = 4;

        // Data Model
        this.projectData = Array.from({length: 4}, () =>
            Array.from({length: 12}, (_, p) => ({
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
                chord: { root:0, oct:3, quality:'maj', ext:'none', inv:0, voice:'close', flux:0 }
            }))
        );

        // Callbacks
        this.onStepTrigger = null; 
        this.onClockTick = null;   
        this.onLog = null;         
    }

    log(msg) {
        if (this.onLog) this.onLog(msg);
        else console.log(msg);
    }

    // --- INITIALIZATION (FIXED) ---
    async init() {
        try {
            // 1. Audio Context
            if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

            // 2. Browser Support Check
            if (!navigator.requestMIDIAccess) {
                this.log("ERR: WEBMIDI UNSUPPORTED");
                return false;
            }

            // 3. Access MIDI
            const m = await navigator.requestMIDIAccess({ sysex: false });
            const outs = Array.from(m.outputs.values());
            
            // LOGGING: Show exactly what we found
            this.log(`SCANNING: FOUND ${outs.length} DEVICES`);
            outs.forEach((o, i) => this.log(`DEV [${i}]: ${o.name}`));

            if (outs.length === 0) {
                this.log("ERR: NO MIDI OUTPUTS FOUND");
                return false;
            }

            // 4. CONNECTION LOGIC (REPAIRED)
            // Priority: Look for Teenage Engineering devices, BUT fall back to *anything* if missing.
            const preferred = outs.find(o => {
                const n = (o.name || '').toLowerCase();
                return n.includes('ep-') || n.includes('teenage') || n.includes('op-') || n.includes('133');
            });

            // If we found a preferred device, use it. Otherwise, use the FIRST one found.
            this.midiOut = preferred || outs[0];
            
            this.log(`LINKED: ${(this.midiOut.name || 'UNKNOWN DEVICE')}`);
            return true;
        } catch (e) {
            this.log(`ERR: ${e.message}`);
            return false;
        }
    }

    // --- PLAYBACK CONTROL ---
    start() {
        if (!this.midiOut || !this.audioCtx) {
            this.log("ERR: INIT MIDI FIRST");
            return;
        }
        
        this.stop(); 
        this.isPlaying = true;
        this.current16thNote = 0;
        this.nextNoteTime = this.audioCtx.currentTime + 0.1;

        if (this.sendTransport && !this.suppressTransport) {
            this.midiOut.send([0xFA]); // MIDI Start
        }

        this.log("ROLLING...");
        this.scheduler();
    }

    stop() {
        this.isPlaying = false;
        if (this.timerID) cancelAnimationFrame(this.timerID);
        
        if (this.midiOut) {
            if (this.sendTransport && !this.suppressTransport) {
                this.midiOut.send([0xFC]); // MIDI Stop
            }
            // All notes off
            for (let ch = 0; ch < 4; ch++) this.midiOut.send([0xB0 + ch, 123, 0]);
        }
        this.suppressTransport = false;
        this.log("HALTED");
    }

    // --- THE LOOP ---
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
        
        if (this.isPlaying) {
            this.timerID = requestAnimationFrame(() => this.scheduler());
        }
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
        const exactTime = time + swingDelay + humanJitter;
        const midiTimestamp = performance.now() + (exactTime - this.audioCtx.currentTime) * 1000;

        for (let g = 0; g < 4; g++) {
            const chan = g; 
            for (let p = 0; p < 12; p++) {
                const pad = this.projectData[g][p];
                const stepIdx = beatNumber % FIXED_STEPS;
                const noteChar = pad.notes[stepIdx];
                
                if (noteChar === 'O' || pad.muted) continue;

                let vel = noteChar === 'X' ? 120 : (noteChar === 'Y' ? 85 : 50);
                if (pad.velMode === 'fixed') vel = pad.velA;
                else if (pad.velMode === 'range') {
                    const lo = Math.min(pad.velA, pad.velB);
                    const hi = Math.max(pad.velA, pad.velB);
                    vel = lo + Math.floor(Math.random() * (hi - lo + 1));
                }
                vel = clamp(Math.round(vel), 1, 127);

                if (pad.mode === 'chord') {
                    this.sendChord(pad, chan, vel, midiTimestamp);
                } else {
                    this.sendMidiNote(chan, pad.midiNote, vel, pad.gateMs, midiTimestamp);
                }

                if (this.onStepTrigger) {
                    const delayMs = (exactTime - this.audioCtx.currentTime) * 1000;
                    setTimeout(() => {
                        this.onStepTrigger(g, p, vel);
                    }, delayMs);
                }
            }
        }
        
        if (this.onClockTick) {
             const delayMs = (exactTime - this.audioCtx.currentTime) * 1000;
             setTimeout(() => this.onClockTick(beatNumber % FIXED_STEPS), delayMs);
        }
    }

    sendMidiNote(chan, note, vel, duration, timestamp) {
        if (!this.midiOut) return;
        const statusOn = 0x90 + chan;
        const statusOff = 0x80 + chan;
        this.midiOut.send([statusOn, note, vel], timestamp);
        this.midiOut.send([statusOff, note, 0], timestamp + duration);
    }

    sendChord(pad, chan, baseVel, timestamp) {
        if (!this.midiOut) return;
        
        let baseNote = (pad.chord.oct + 1) * 12 + pad.chord.root;
        let intervals = getChordIntervals(pad.chord.quality, pad.chord.ext);
        const fluxVal = pad.chord.flux / 100;
        let inv = pad.chord.inv;
        
        if (fluxVal > 0 && Math.random() < fluxVal) {
            if (Math.random() > 0.5) inv = (inv + 1) % 4;
            if (fluxVal > 0.6 && Math.random() > 0.8) baseNote += (Math.random() > 0.5 ? 12 : -12);
        }

        intervals = applyInversion(intervals, inv);
        intervals = applyVoicing(intervals, pad.chord.voice);

        intervals.forEach((interval, i) => {
            const noteNum = baseNote + interval;
            const strum = i * (5 + (fluxVal * 20)); 
            const velVar = clamp(Math.round(baseVel + ((Math.random() - 0.5) * fluxVal * 40)), 1, 127);
            this.sendMidiNote(chan, noteNum, velVar, pad.gateMs, timestamp + strum);
        });
    }
}

/* --- FULL PRESETS --- */
export const PRESETS = {
    "KICK (Single Pad)": [
        { name: "XOOO XOOO XOOO XOOO", pat: "XOOO XOOO XOOO XOOO" },
        { name: "XOOX XOOX XOOX XOOX", pat: "XOOX XOOX XOOX XOOX" },
        { name: "XOOO XXOO XOOO XXOO", pat: "XOOO XXOO XOOO XXOO" }
    ],
    "SNARE (Single Pad)": [
        { name: "OOOO XOOO OOOO XOOO", pat: "OOOO XOOO OOOO XOOO" },
        { name: "OOOO XOOO OOOO XOOZ", pat: "OOOO XOOO OOOO XOOZ" }
    ],
    "HATS (Single Pad)": [
        { name: "XOXO XOXO XOXO XOXO", pat: "XOXO XOXO XOXO XOXO" },
        { name: "XXXX XXXX XXXX XXXX", pat: "XXXX XXXX XXXX XXXX" }
    ],
    "FULL KITS": [
        { name: "Basic House Kit", type: "multi", tracks: { 0:"XOOOXOOOXOOOXOOO", 1:"OOOOXOOOOOOOXOOO", 2:"OOXOOOXOOOXOOOXO" } },
        { name: "Trap Banger", type: "multi", tracks: { 0:"XOOOOOOOXOOOOOOO", 1:"OOOOOOOOXOOOOOOO", 2:"XZXZXZXZXXXXXZXZ" } }
    ]
};
