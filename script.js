///////////////////////////////////////////////////////////////////////////////
// NSC Music Timer — Multi-Mode (Hybrid / Speed / Burnout)
// One template, three isolated app instances, each with its own DB namespace.
///////////////////////////////////////////////////////////////////////////////

const MODES = ["hybrid", "speed", "burnout"];
let CURRENT_MODE = "hybrid";

// Each mode stores its OWN app instance object:
const appInstances = {};

window.addEventListener("load", () => {
    loadTemplateIntoPages();
    setupTabs();
    initMode("hybrid");       // default
});

///////////////////////////////////////////////////////////////////////////////
// LOAD TEMPLATE INTO EACH MODE PAGE
///////////////////////////////////////////////////////////////////////////////
function loadTemplateIntoPages() {
    const tpl = document.getElementById("appTemplate");

    MODES.forEach(mode => {
        const page = document.getElementById("page-" + mode);
        const clone = tpl.content.cloneNode(true);
        page.appendChild(clone);

        appInstances[mode] = createBlankAppInstance(page);
    });
}

///////////////////////////////////////////////////////////////////////////////
// CREATE NEW APP INSTANCE OBJECT
///////////////////////////////////////////////////////////////////////////////
function createBlankAppInstance(root) {
    return {
        root,
        db: null,
        audioCtx: null,
        beepBuffer: null,
        songs: [],
        mainWave: null,
        lastCombinedBuffer: null,
        beepSecondsLeft: [180, 120, 60, 30, 10],
        TIME_LIMIT: 240 // seconds
    };
}

///////////////////////////////////////////////////////////////////////////////
// TAB SWITCHING
///////////////////////////////////////////////////////////////////////////////
function setupTabs() {
    document.querySelectorAll(".tabBtn").forEach(btn => {
        btn.addEventListener("click", () => {
            switchMode(btn.dataset.tab);
        });
    });
}

function switchMode(mode) {
    CURRENT_MODE = mode;

    document.querySelectorAll(".tabBtn")
        .forEach(b => b.classList.remove("active"));
    document.querySelector(`.tabBtn[data-tab="${mode}"]`).classList.add("active");

    document.querySelectorAll(".modePage")
        .forEach(p => p.classList.add("hidden"));
    document.getElementById("page-" + mode).classList.remove("hidden");

    initMode(mode);
}

///////////////////////////////////////////////////////////////////////////////
// INITIALIZE A MODE (IndexedDB load + wiring)
///////////////////////////////////////////////////////////////////////////////
async function initMode(mode) {
    const app = appInstances[mode];

    if (!app.db) {
        await initDB(mode, app);
        await loadSettingsFromDB(app);
        await loadSongsFromDB(app);
    }

    wireButtons(app);
    enableDragReorder(app);
}

///////////////////////////////////////////////////////////////////////////////
// INDEXEDDB SETUP — PER MODE
///////////////////////////////////////////////////////////////////////////////
function initDB(mode, app) {
    return new Promise(res => {
        const req = indexedDB.open(`nsc-timer-db-${mode}`, 5);

        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("songs"))
                db.createObjectStore("songs", { keyPath: "id", autoIncrement: true });
            if (!db.objectStoreNames.contains("settings"))
                db.createObjectStore("settings", { keyPath: "key" });
        };

        req.onsuccess = e => {
            app.db = e.target.result;
            res();
        };
    });
}

// dbPut now resolves with the key (id) assigned by IndexedDB
function dbPut(app, store, value) {
    return new Promise((resolve, reject) => {
        const tx = app.db.transaction([store], "readwrite");
        const os = tx.objectStore(store);
        const req = os.put(value);

        req.onsuccess = () => resolve(req.result);
        req.onerror = e => {
            console.error("dbPut error:", e);
            reject(e);
        };
    });
}

function dbGetAll(app, store) {
    return new Promise(res => {
        const tx = app.db.transaction([store]);
        const q = tx.objectStore(store).getAll();
        q.onsuccess = () => res(q.result || []);
    });
}

function dbGet(app, store, key) {
    return new Promise(res => {
        const tx = app.db.transaction([store]);
        const q = tx.objectStore(store).get(key);
        q.onsuccess = () => res(q.result || null);
    });
}

///////////////////////////////////////////////////////////////////////////////
// SETTINGS LOAD/SAVE
///////////////////////////////////////////////////////////////////////////////
async function loadSettingsFromDB(app) {
    const s = await dbGet(app, "settings", "main");
    if (!s) return;

    app.beepSecondsLeft = s.beepTimes ?? app.beepSecondsLeft;
    app.TIME_LIMIT = s.timeLimit ?? app.TIME_LIMIT;

    // Update UI
    app.root.querySelector(".starterBeepToggle").checked = !!s.starterBeep;
    app.root.querySelector(".darkSwitch").checked = !!s.darkMode;

    if (s.darkMode) document.documentElement.classList.add("dark");

    app.root.querySelector(".timeLimit").value = (app.TIME_LIMIT / 60).toFixed(2);

    renderBeepInputs(app);
}

function saveSettingsToDB(app) {
    dbPut(app, "settings", {
        key: "main",
        beepTimes: app.beepSecondsLeft,
        starterBeep: app.root.querySelector(".starterBeepToggle").checked,
        timeLimit: app.TIME_LIMIT,
        darkMode: app.root.querySelector(".darkSwitch").checked
    }).catch(err => console.error("Error saving settings:", err));
}

///////////////////////////////////////////////////////////////////////////////
// WIRES BUTTONS PER INSTANCE
///////////////////////////////////////////////////////////////////////////////
function wireButtons(app) {
    const r = app.root;

    r.querySelector(".addSong").onclick = () => addSongBlock(app);
    r.querySelector(".buildTrack").onclick = () => buildTrack(app);
    r.querySelector(".startRun").onclick = () => startRun(app);

    // NEW: export button handler
    const exportBtn = r.querySelector(".exportTrack");
    if (exportBtn) {
        exportBtn.onclick = () => exportTrack(app);
    }

    r.querySelector(".pauseBtn").onclick = () => app.mainWave?.pause();
    r.querySelector(".resumeBtn").onclick = () => app.mainWave?.play();
    r.querySelector(".restartBtn").onclick = () => {
        if (app.mainWave) { app.mainWave.seekTo(0); app.mainWave.play(); }
    };

    r.querySelector(".saveTimeLimit").onclick = () => {
        const min = parseFloat(r.querySelector(".timeLimit").value);
        if (!isNaN(min)) {
            app.TIME_LIMIT = min * 60;
            saveSettingsToDB(app);
        }
    };

    r.querySelector(".darkSwitch").onchange = () => {
        document.documentElement.classList.toggle("dark");
        saveSettingsToDB(app);
    };

    r.querySelector(".addBeep").onclick = () => {
        app.beepSecondsLeft.push(60);
        renderBeepInputs(app);
        saveSettingsToDB(app);
    };

    r.querySelector(".saveBeeps").onclick = () => {
        app.beepSecondsLeft = Array.from(
            r.querySelectorAll(".beepList input")
        ).map(v => Number(v.value));
        saveSettingsToDB(app);
        if (app.lastCombinedBuffer) makeMainWaveform(app, app.lastCombinedBuffer);
    };
}

///////////////////////////////////////////////////////////////////////////////
// BEEP INPUTS
///////////////////////////////////////////////////////////////////////////////
function renderBeepInputs(app) {
    const list = app.root.querySelector(".beepList");
    list.innerHTML = "";

    app.beepSecondsLeft.forEach((sec, i) => {
        const div = document.createElement("div");
        div.innerHTML = `
            <input type="number" value="${sec}">
            <button class="removeBeepBtn">X</button>
        `;
        div.querySelector(".removeBeepBtn").onclick = () => {
            app.beepSecondsLeft.splice(i, 1);
            renderBeepInputs(app);
            saveSettingsToDB(app);
        };
        list.appendChild(div);
    });
}

///////////////////////////////////////////////////////////////////////////////
// LOAD SONGS FROM DB
///////////////////////////////////////////////////////////////////////////////
async function loadSongsFromDB(app) {
    const stored = await dbGetAll(app, "songs");
    app.songs = []; // reset in-memory list to match DB
    for (const s of stored) {
        await restoreSongFromDB(app, s);
    }
    renderBeepInputs(app);
}

///////////////////////////////////////////////////////////////////////////////
// SONG BLOCK — UI ELEMENT CREATION
///////////////////////////////////////////////////////////////////////////////
function addSongBlock(app) {
    const container = app.root.querySelector(".songContainer");
    const id = "wave-" + Math.random().toString(36).slice(2);

    const div = document.createElement("div");
    div.className = "song-block";
    div.dataset.songId = "0";

    div.innerHTML = `
        <input class="songTitle" placeholder="Song Title">
        <button class="deleteSong">Delete</button>
        <br>

        <input type="file" class="song-file" accept="audio/*">

        <div class="song-controls">
            <button class="previewPlay">Preview</button>
            <button class="previewPause">Pause</button>
        </div>

        <div class="wave" id="${id}"></div>
    `;

    container.appendChild(div);

    div.querySelector(".deleteSong").onclick = () => deleteSong(app, div);

    div.querySelector(".song-file").onchange = e => {
        if (e.target.files.length > 0)
            loadNewSong(app, e.target.files[0], id, div);
    };

    return div;
}

///////////////////////////////////////////////////////////////////////////////
// DELETE SONG
///////////////////////////////////////////////////////////////////////////////
function deleteSong(app, blockEl) {
    const idx = [...blockEl.parentNode.children].indexOf(blockEl);
    if (idx >= 0) {
        app.songs.splice(idx, 1);
    }
    blockEl.remove();
    saveAllSongsToDB(app);
}

///////////////////////////////////////////////////////////////////////////////
// SAVE ALL SONGS AFTER REORDER/DELETE
///////////////////////////////////////////////////////////////////////////////
function saveAllSongsToDB(app) {
    const tx = app.db.transaction(["songs"], "readwrite");
    const store = tx.objectStore("songs");
    const clearReq = store.clear();
    clearReq.onsuccess = () => {
        app.songs.forEach(s => saveSongToDB(app, s));
    };
    clearReq.onerror = e => {
        console.error("Error clearing songs store:", e);
    };
}

///////////////////////////////////////////////////////////////////////////////
// DRAG REORDER
///////////////////////////////////////////////////////////////////////////////
function enableDragReorder(app) {
    const container = app.root.querySelector(".songContainer");
    if (!container._sortableBound) {
        container._sortableBound = true;
        new Sortable(container, {
            animation: 150,
            onEnd: () => {
                const blocks = [...app.root.querySelectorAll(".song-block")];
                const newOrder = [];
                blocks.forEach(b => {
                    const id = b.dataset.songId;
                    const s = app.songs.find(x => String(x.id) === String(id));
                    if (s) newOrder.push(s);
                });
                app.songs = newOrder;
                saveAllSongsToDB(app);
            }
        });
    }
}

///////////////////////////////////////////////////////////////////////////////
// LOAD NEW SONG FILE
///////////////////////////////////////////////////////////////////////////////
function loadNewSong(app, file, waveId, blockEl) {
    const wave = WaveSurfer.create({
        container: "#" + waveId,
        waveColor: "#33aaff",
        progressColor: "#77ddff",
        height: 120,
        plugins: [WaveSurfer.regions.create({})]
    });

    wave.loadBlob(file);

    wave.on("ready", async () => {
        const dur = wave.getDuration();

        const left = wave.addRegion({
            start: 0, end: 0.4,
            drag: false, resize: true,
            color: "rgba(255,0,0,0.18)"
        });

        const right = wave.addRegion({
            start: dur - 0.4, end: dur,
            drag: false, resize: true,
            color: "rgba(0,255,0,0.18)"
        });

        const buffer = await file.arrayBuffer();

        const titleInput = blockEl.querySelector(".songTitle");

        const obj = {
            id: null,
            file,
            wave,
            leftHandle: left,
            rightHandle: right,
            arrayBuffer: buffer,
            title: titleInput.value || file.name,
            blockEl
        };

        blockEl.dataset.songId = "pending";

        left.on("update-end", () => saveSongToDB(app, obj));
        right.on("update-end", () => saveSongToDB(app, obj));

        blockEl.querySelector(".previewPlay").onclick =
            () => wave.play(left.end, right.start);

        blockEl.querySelector(".previewPause").onclick =
            () => wave.pause();

        titleInput.oninput = () => {
            obj.title = titleInput.value;
            saveSongToDB(app, obj);
        };

        app.songs.push(obj);
        saveSongToDB(app, obj);
    });
}

///////////////////////////////////////////////////////////////////////////////
// RESTORE SONG FROM DB
///////////////////////////////////////////////////////////////////////////////
async function restoreSongFromDB(app, saved) {
    const block = addSongBlock(app);
    const waveId = block.querySelector(".wave").id;

    const file = new File([saved.data], saved.name, { type: saved.type });

    const wave = WaveSurfer.create({
        container: "#" + waveId,
        waveColor: "#33aaff",
        progressColor: "#77ddff",
        height: 120,
        plugins: [WaveSurfer.regions.create({})]
    });

    wave.loadBlob(file);

    wave.on("ready", () => {
        const dur = wave.getDuration();

        const left = wave.addRegion({
            start: 0,
            end: saved.trimStart,
            drag: false,
            resize: true,
            color: "rgba(255,0,0,0.18)"
        });

        const right = wave.addRegion({
            start: saved.trimEnd,
            end: dur,
            drag: false,
            resize: true,
            color: "rgba(0,255,0,0.18)"
        });

        const obj = {
            id: saved.id,
            file,
            wave,
            leftHandle: left,
            rightHandle: right,
            arrayBuffer: saved.data,
            title: saved.title || saved.name,
            blockEl: block
        };

        block.dataset.songId = saved.id;

        const titleInput = block.querySelector(".songTitle");
        titleInput.value = obj.title;
        titleInput.oninput = () => {
            obj.title = titleInput.value;
            saveSongToDB(app, obj);
        };

        block.querySelector(".previewPlay").onclick =
            () => wave.play(left.end, right.start);

        block.querySelector(".previewPause").onclick =
            () => wave.pause();

        left.on("update-end", () => saveSongToDB(app, obj));
        right.on("update-end", () => saveSongToDB(app, obj));

        app.songs.push(obj);
    });
}

///////////////////////////////////////////////////////////////////////////////
// SAVE SONG TO DB
///////////////////////////////////////////////////////////////////////////////
function saveSongToDB(app, obj) {
    if (!app.db) return;

    const rec = {
        name: obj.file.name,
        type: obj.file.type,
        data: obj.arrayBuffer,
        trimStart: obj.leftHandle.end,
        trimEnd: obj.rightHandle.start,
        title: obj.title
    };

    if (obj.id != null) {
        rec.id = obj.id;
    }

    dbPut(app, "songs", rec)
        .then(id => {
            // For newly inserted records, update id and DOM
            if (obj.id == null) {
                obj.id = id;
                if (obj.blockEl) {
                    obj.blockEl.dataset.songId = id;
                }
            }
        })
        .catch(err => {
            console.error("Error saving song:", err);
        });
}

///////////////////////////////////////////////////////////////////////////////
// BUILD FINAL TRACK
///////////////////////////////////////////////////////////////////////////////
async function buildTrack(app) {
    if (!app.songs || app.songs.length === 0) {
        alert("No songs loaded. Add at least one song first.");
        return;
    }

    app.audioCtx = new AudioContext();

    // Load beep sound (used later for playback/export)
    try {
        const beepData = await fetch("beep.wav");
        const beepArrayBuf = await beepData.arrayBuffer();
        app.beepBuffer = await app.audioCtx.decodeAudioData(beepArrayBuf);
    } catch (e) {
        console.warn("Could not load beep.wav. Beeps may not play/export correctly.", e);
    }

    const RUN = app.TIME_LIMIT;
    const rate = app.audioCtx.sampleRate;
    const final = app.audioCtx.createBuffer(2, RUN * rate, rate);

    let offset = 0;

    for (let s of app.songs) {
        if (!s.arrayBuffer) continue;

        const decoded = await decodeFixRate(app, s.arrayBuffer);

        const L = Math.floor(s.leftHandle.end * rate);
        const R = Math.floor(s.rightHandle.start * rate);

        const length = R - L;
        if (length <= 0) continue;

        const rem = (RUN * rate) - offset;
        if (rem <= 0) break;

        const copy = Math.min(length, rem);

        for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            final.getChannelData(ch).set(
                decoded.getChannelData(ch).slice(L, L + copy),
                offset
            );
        }

        offset += copy;
        if (offset >= RUN * rate) break;
    }

    app.lastCombinedBuffer = final;
    makeMainWaveform(app, final);

    app.root.querySelector(".startRun").disabled = false;

    // enable export button once we have a final buffer
    const exportBtn = app.root.querySelector(".exportTrack");
    if (exportBtn) exportBtn.disabled = false;

    alert("Track built!");
}

async function decodeFixRate(app, buf) {
    const original = await app.audioCtx.decodeAudioData(buf);
    if (original.sampleRate === app.audioCtx.sampleRate) return original;

    const off = new OfflineAudioContext(
        original.numberOfChannels,
        original.duration * app.audioCtx.sampleRate,
        app.audioCtx.sampleRate
    );
    const src = off.createBufferSource();
    src.buffer = original;
    src.connect(off.destination);
    src.start();
    return off.startRendering();
}

///////////////////////////////////////////////////////////////////////////////
// MAIN WAVEFORM
///////////////////////////////////////////////////////////////////////////////
function makeMainWaveform(app, buffer) {
    if (app.mainWave) app.mainWave.destroy();

    app.mainWave = WaveSurfer.create({
        container: app.root.querySelector(".mainWaveform"),
        waveColor: "#44dd66",
        progressColor: "#66ff88",
        height: 150,
        plugins: [
            WaveSurfer.timeline.create({
                container: app.root.querySelector(".mainTimeline")
            })
        ]
    });

    app.mainWave.loadDecodedBuffer(buffer);

    app.mainWave.on("ready", () => {
        const drawer = app.mainWave.drawer;
        app.beepSecondsLeft.forEach(sec => {
            const t = app.TIME_LIMIT - sec;
            const x = drawer.width * (t / app.TIME_LIMIT);

            const ctx = drawer.canvasContext;
            ctx.save();
            ctx.strokeStyle = "rgba(255,0,0,0.9)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, drawer.height);
            ctx.stroke();
            ctx.restore();
        });
    });
}

///////////////////////////////////////////////////////////////////////////////
// EXPORT FINAL TRACK TO WAV
///////////////////////////////////////////////////////////////////////////////
function exportTrack(app) {
    if (!app.lastCombinedBuffer) {
        alert("Build the track first.");
        return;
    }

    if (!app.audioCtx || !app.beepBuffer) {
        alert("Beep sound not loaded. Please rebuild the track first.");
        return;
    }

    const base = app.lastCombinedBuffer; // songs only
    const sampleRate = base.sampleRate;
    const numChannels = base.numberOfChannels;

    // Is ANW starter beeps toggle on?
    const starterOn = app.root.querySelector(".starterBeepToggle").checked;

    // If starter beeps are on, we add 3 seconds before the music:
    //  - beep at t=0, 1, 2   (3-2-1)
    //  - music starts at t=3
    const preRunSeconds = starterOn ? 3 : 0;

    const musicSeconds = base.length / sampleRate;
    const totalSeconds = preRunSeconds + musicSeconds;

    const exportLength = Math.floor(totalSeconds * sampleRate);
    const exportBuf = app.audioCtx.createBuffer(numChannels, exportLength, sampleRate);

    // Copy music into export buffer, starting at preRunSeconds
    for (let ch = 0; ch < numChannels; ch++) {
        const destData = exportBuf.getChannelData(ch);
        const srcData  = base.getChannelData(ch);
        destData.set(srcData, Math.floor(preRunSeconds * sampleRate));
    }

    // Mix in beeps
    const beepBuf = app.beepBuffer;

    // Starter beeps at t = 0, 1, 2 s (ONLY in exported file)
    if (starterOn) {
        [0, 1, 2].forEach(t => {
            mixBeepIntoBuffer(exportBuf, beepBuf, t);
        });
    }

    // Timing beeps: at "TIME_LIMIT - secLeft", but shifted by preRunSeconds
    app.beepSecondsLeft.forEach(secLeft => {
        const t = preRunSeconds + (app.TIME_LIMIT - secLeft);
        if (t >= 0 && t < totalSeconds) {
            mixBeepIntoBuffer(exportBuf, beepBuf, t);
        }
    });

    // Convert to WAV and download
    const wavBuffer = audioBufferToWav(exportBuf);
    const blob = new Blob([wavBuffer], { type: "audio/wav" });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `NSC_${CURRENT_MODE}_${ts}.wav`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}

function mixBeepIntoBuffer(destBuf, beepBuf, timeSec) {
    const sampleRate = destBuf.sampleRate;
    const startSample = Math.floor(timeSec * sampleRate);

    const destChannels = destBuf.numberOfChannels;
    const beepChannels = beepBuf.numberOfChannels;
    const beepLength   = beepBuf.length;

    for (let i = 0; i < beepLength; i++) {
        const destIndex = startSample + i;
        if (destIndex >= destBuf.length) break;

        for (let ch = 0; ch < destChannels; ch++) {
            const srcChIndex = ch < beepChannels ? ch : 0;

            const destData = destBuf.getChannelData(ch);
            const srcData  = beepBuf.getChannelData(srcChIndex);

            let sample = destData[destIndex] + srcData[i];

            if (sample > 1) sample = 1;
            if (sample < -1) sample = -1;

            destData[destIndex] = sample;
        }
    }
}

// Helper: convert Web Audio AudioBuffer to 16-bit PCM WAV
function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const samples = buffer.length;
    const blockAlign = numChannels * bitDepth / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples * blockAlign;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    let offset = 0;

    function writeString(str) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset++, str.charCodeAt(i));
        }
    }

    // RIFF chunk descriptor
    writeString("RIFF");
    view.setUint32(offset, 36 + dataSize, true); offset += 4;
    writeString("WAVE");

    // fmt subchunk
    writeString("fmt ");
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, format, true); offset += 2;
    view.setUint16(offset, numChannels, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, byteRate, true); offset += 4;
    view.setUint16(offset, blockAlign, true); offset += 2;
    view.setUint16(offset, bitDepth, true); offset += 2;

    // data subchunk
    writeString("data");
    view.setUint32(offset, dataSize, true); offset += 4;

    // Interleave channel data
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
        channelData.push(buffer.getChannelData(ch));
    }

    for (let i = 0; i < samples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            let sample = channelData[ch][i];
            sample = Math.max(-1, Math.min(1, sample));
            view.setInt16(offset, sample * 0x7fff, true);
            offset += 2;
        }
    }

    return arrayBuffer;
}

///////////////////////////////////////////////////////////////////////////////
// RUN START
///////////////////////////////////////////////////////////////////////////////
function startRun(app) {
    if (!app.mainWave) return;

    const starter = app.root.querySelector(".starterBeepToggle").checked;

    if (starter) {
        playAfter(app, 0);
        playAfter(app, 1);
        playAfter(app, 2);

        setTimeout(() => {
            app.mainWave.seekTo(0);
            app.mainWave.play();
            scheduleBeeps(app);
        }, 3000);

    } else {
        app.mainWave.seekTo(0);
        app.mainWave.play();
        scheduleBeeps(app);
    }
}

function playAfter(app, t) {
    setTimeout(() => playBeep(app), t * 1000);
}

function scheduleBeeps(app) {
    app.beepSecondsLeft.forEach(sec => {
        const t = app.TIME_LIMIT - sec;
        setTimeout(() => playBeep(app), t * 1000);
    });
}

function playBeep(app) {
    if (!app.audioCtx || !app.beepBuffer) return;
    const src = app.audioCtx.createBufferSource();
    src.buffer = app.beepBuffer;
    src.connect(app.audioCtx.destination);
    src.start();
}
