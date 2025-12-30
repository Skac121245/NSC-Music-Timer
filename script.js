///////////////////////////////////////////////////////////////////////////////
// NSC Music Timer — Multi-Mode (Hybrid / Speed / Burnout)
///////////////////////////////////////////////////////////////////////////////

const MODES = ["hybrid", "speed", "burnout"];
let CURRENT_MODE = "hybrid";

const appInstances = {};

window.addEventListener("load", () => {
    loadTemplateIntoPages();
    setupTabs();
    initMode("hybrid");
});

function loadTemplateIntoPages() {
    const tpl = document.getElementById("appTemplate");

    MODES.forEach(mode => {
        const page = document.getElementById("page-" + mode);
        page.appendChild(tpl.content.cloneNode(true));
        appInstances[mode] = createBlankAppInstance(page);
    });
}

function createBlankAppInstance(root) {
    return {
        root,
        db: null,

        audioCtx: null,
        beepBuffer: null,

        // Intro
        intro: null,
        introDecoded: null,
        introSources: [],

        // Songs -> combined buffer
        songs: [],
        mainWave: null,
        lastCombinedBuffer: null,

        // Coach Talk graph
        graphReady: false,
        splitter: null,
        merger: null,
        musicGainL: null,
        musicGainR: null,
        micGain: null,
        micComp: null,
        micStream: null,
        micSource: null,
        micOn: false,

        // Playback (our own, WaveSurfer is visual)
        runSource: null,
        runStartCtxTime: 0,
        runOffsetSec: 0,
        runPlaying: false,
        runTimer: null,

        beepSecondsLeft: [180, 120, 60, 30, 10],
        TIME_LIMIT: 240
    };
}

function setupTabs() {
    document.querySelectorAll(".tabBtn").forEach(btn => {
        btn.addEventListener("click", () => switchMode(btn.dataset.tab));
    });
}

function switchMode(mode) {
    CURRENT_MODE = mode;

    document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));
    document.querySelector(`.tabBtn[data-tab="${mode}"]`).classList.add("active");

    document.querySelectorAll(".modePage").forEach(p => p.classList.add("hidden"));
    document.getElementById("page-" + mode).classList.remove("hidden");

    initMode(mode);
}

async function initMode(mode) {
    const app = appInstances[mode];

    if (!app.db) {
        await initDB(mode, app);
        await loadSettingsFromDB(app);
        await loadIntroFromDB(app);
        await loadSongsFromDB(app);
    }

    wireButtons(app);
    enableDragReorder(app);

    // Coach button can be enabled once we have an AudioContext (build or startRun)
    const coachBtn = app.root.querySelector(".coachHold");
    if (coachBtn) coachBtn.disabled = false;
}

///////////////////////////////////////////////////////////////////////////////
// DB
///////////////////////////////////////////////////////////////////////////////
function initDB(mode, app) {
    return new Promise(res => {
        const req = indexedDB.open(`nsc-timer-db-${mode}`, 6);

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

function dbPut(app, store, value) {
    return new Promise((resolve, reject) => {
        const tx = app.db.transaction([store], "readwrite");
        const os = tx.objectStore(store);
        const req = os.put(value);

        req.onsuccess = () => resolve(req.result);
        req.onerror = e => reject(e);
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

async function loadSettingsFromDB(app) {
    const s = await dbGet(app, "settings", "main");
    if (!s) return;

    app.beepSecondsLeft = s.beepTimes ?? app.beepSecondsLeft;
    app.TIME_LIMIT = s.timeLimit ?? app.TIME_LIMIT;

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
    }).catch(console.error);
}

///////////////////////////////////////////////////////////////////////////////
// UI Wiring
///////////////////////////////////////////////////////////////////////////////
function wireButtons(app) {
    const r = app.root;

    r.querySelector(".addIntro").onclick = () => addOrReplaceIntro(app);
    r.querySelector(".clearIntro").onclick = async () => {
        stopIntroPlayback(app);
        app.intro = null;
        app.introDecoded = null;
        r.querySelector(".introContainer").innerHTML = "";
        renderIntroEmpty(app);
        await clearIntroFromDB(app);
    };

    r.querySelector(".addSong").onclick = () => addSongBlock(app);
    r.querySelector(".buildTrack").onclick = () => buildTrack(app);
    r.querySelector(".startRun").onclick = () => startRun(app);

    const exportBtn = r.querySelector(".exportTrack");
    if (exportBtn) exportBtn.onclick = () => exportTrack(app);

    r.querySelector(".pauseBtn").onclick = () => pauseRun(app);
    r.querySelector(".resumeBtn").onclick = () => resumeRun(app);
    r.querySelector(".restartBtn").onclick = () => restartRun(app);

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
        app.beepSecondsLeft = Array.from(r.querySelectorAll(".beepList input")).map(v => Number(v.value));
        saveSettingsToDB(app);
        if (app.lastCombinedBuffer) makeMainWaveform(app, app.lastCombinedBuffer);
    };

    // Coach controls
    const duck = r.querySelector(".coachDuck");
    const duckVal = r.querySelector(".coachDuckVal");
    if (duck && duckVal) {
        duckVal.textContent = `${Math.round(parseFloat(duck.value) * 100)}%`;
        duck.oninput = () => duckVal.textContent = `${Math.round(parseFloat(duck.value) * 100)}%`;
    }

    const coachBtn = r.querySelector(".coachHold");
    if (coachBtn && !coachBtn._bound) {
        coachBtn._bound = true;

        const down = async (e) => {
            e.preventDefault();
            await coachStart(app);
        };
        const up = async (e) => {
            e.preventDefault();
            await coachStop(app);
        };

        coachBtn.addEventListener("pointerdown", down);
        coachBtn.addEventListener("pointerup", up);
        coachBtn.addEventListener("pointercancel", up);
        coachBtn.addEventListener("pointerleave", (e) => {
            // If the user drags finger/mouse away while held, stop talking
            if (app.micOn) up(e);
        });
    }
}

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
// INTRO Storage
///////////////////////////////////////////////////////////////////////////////
async function loadIntroFromDB(app) {
    const saved = await dbGet(app, "settings", "intro");
    if (!saved) {
        renderIntroEmpty(app);
        return;
    }
    await restoreIntroFromDB(app, saved);
}

function saveIntroToDB(app, introObj) {
    if (!app.db) return;

    const rec = {
        key: "intro",
        name: introObj.file.name,
        type: introObj.file.type,
        data: introObj.arrayBuffer,
        trimStart: introObj.leftHandle.end,
        trimEnd: introObj.rightHandle.start,
        title: introObj.title
    };

    dbPut(app, "settings", rec).catch(console.error);
}

async function clearIntroFromDB(app) {
    return new Promise(resolve => {
        const tx = app.db.transaction(["settings"], "readwrite");
        const store = tx.objectStore("settings");
        const req = store.delete("intro");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
    });
}

function renderIntroEmpty(app) {
    const c = app.root.querySelector(".introContainer");
    c.innerHTML = `<div class="hintText">No intro set.</div>`;
}

function addOrReplaceIntro(app) {
    const c = app.root.querySelector(".introContainer");
    c.innerHTML = "";

    const id = "intro-wave-" + Math.random().toString(36).slice(2);

    const div = document.createElement("div");
    div.className = "intro-block";
    div.innerHTML = `
        <input class="songTitle introTitle" placeholder="Intro Title">
        <br>
        <input type="file" class="intro-file" accept="audio/*">

        <div class="song-controls">
            <button class="introPreviewPlay">Preview</button>
            <button class="introPreviewPause">Pause</button>
        </div>

        <div class="wave" id="${id}"></div>
    `;

    c.appendChild(div);

    div.querySelector(".intro-file").onchange = e => {
        if (e.target.files.length > 0)
            loadNewIntro(app, e.target.files[0], id, div);
    };
}

async function loadNewIntro(app, file, waveId, blockEl) {
    stopIntroPlayback(app);
    if (app.intro?.wave) {
        try { app.intro.wave.destroy(); } catch {}
    }
    app.intro = null;
    app.introDecoded = null;

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
            start: 0, end: Math.min(0.4, dur),
            drag: false, resize: true,
            color: "rgba(255,0,0,0.18)"
        });

        const right = wave.addRegion({
            start: Math.max(dur - 0.4, 0), end: dur,
            drag: false, resize: true,
            color: "rgba(0,255,0,0.18)"
        });

        const buffer = await file.arrayBuffer();
        const titleInput = blockEl.querySelector(".introTitle");

        const obj = {
            file,
            wave,
            leftHandle: left,
            rightHandle: right,
            arrayBuffer: buffer,
            title: titleInput.value || file.name,
            blockEl
        };

        blockEl.querySelector(".introPreviewPlay").onclick = () => wave.play(left.end, right.start);
        blockEl.querySelector(".introPreviewPause").onclick = () => wave.pause();

        titleInput.oninput = () => { obj.title = titleInput.value; saveIntroToDB(app, obj); };
        left.on("update-end", () => saveIntroToDB(app, obj));
        right.on("update-end", () => saveIntroToDB(app, obj));

        app.intro = obj;
        saveIntroToDB(app, obj);
    });
}

async function restoreIntroFromDB(app, saved) {
    const c = app.root.querySelector(".introContainer");
    c.innerHTML = "";

    const id = "intro-wave-" + Math.random().toString(36).slice(2);

    const div = document.createElement("div");
    div.className = "intro-block";
    div.innerHTML = `
        <input class="songTitle introTitle" placeholder="Intro Title">
        <br>
        <input type="file" class="intro-file" accept="audio/*">

        <div class="song-controls">
            <button class="introPreviewPlay">Preview</button>
            <button class="introPreviewPause">Pause</button>
        </div>

        <div class="wave" id="${id}"></div>
    `;
    c.appendChild(div);

    const file = new File([saved.data], saved.name, { type: saved.type });

    const wave = WaveSurfer.create({
        container: "#" + id,
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
            file,
            wave,
            leftHandle: left,
            rightHandle: right,
            arrayBuffer: saved.data,
            title: saved.title || saved.name,
            blockEl: div
        };

        const titleInput = div.querySelector(".introTitle");
        titleInput.value = obj.title;

        div.querySelector(".intro-file").onchange = e => {
            if (e.target.files.length > 0) loadNewIntro(app, e.target.files[0], id, div);
        };

        div.querySelector(".introPreviewPlay").onclick = () => wave.play(left.end, right.start);
        div.querySelector(".introPreviewPause").onclick = () => wave.pause();

        titleInput.oninput = () => { obj.title = titleInput.value; saveIntroToDB(app, obj); };
        left.on("update-end", () => saveIntroToDB(app, obj));
        right.on("update-end", () => saveIntroToDB(app, obj));

        app.intro = obj;
    });
}

///////////////////////////////////////////////////////////////////////////////
// SONGS
///////////////////////////////////////////////////////////////////////////////
async function loadSongsFromDB(app) {
    const stored = await dbGetAll(app, "songs");
    app.songs = [];
    for (const s of stored) await restoreSongFromDB(app, s);
    renderBeepInputs(app);
}

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
            <button class="saveSongBtn" disabled>Save</button>
        </div>

        <div class="wave" id="${id}"></div>
    `;

    container.appendChild(div);

    div.querySelector(".deleteSong").onclick = () => deleteSong(app, div);

    div.querySelector(".song-file").onchange = e => {
        if (e.target.files.length > 0) loadNewSong(app, e.target.files[0], id, div);
    };

    return div;
}

function deleteSong(app, blockEl) {
    const idx = [...blockEl.parentNode.children].indexOf(blockEl);
    if (idx >= 0) app.songs.splice(idx, 1);
    blockEl.remove();
    saveAllSongsToDB(app);
}

function saveAllSongsToDB(app) {
    const tx = app.db.transaction(["songs"], "readwrite");
    const store = tx.objectStore("songs");
    const clearReq = store.clear();
    clearReq.onsuccess = () => app.songs.forEach(s => saveSongToDB(app, s));
    clearReq.onerror = console.error;
}

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
            start: 0, end: Math.min(0.4, dur),
            drag: false, resize: true,
            color: "rgba(255,0,0,0.18)"
        });

        const right = wave.addRegion({
            start: Math.max(dur - 0.4, 0), end: dur,
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

        // Manual save button (confidence click)
        const saveBtn = blockEl.querySelector(".saveSongBtn");
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.onclick = async () => {
                const prev = saveBtn.textContent;
                saveBtn.textContent = "Saving...";
                try {
                    await saveSongToDB(app, obj);
                    saveBtn.textContent = "Saved!";
                    setTimeout(() => { saveBtn.textContent = prev; }, 700);
                } catch (e) {
                    console.error(e);
                    saveBtn.textContent = "Error";
                    setTimeout(() => { saveBtn.textContent = prev; }, 1000);
                }
            };
        }

        blockEl.dataset.songId = "pending";

        left.on("update-end", () => saveSongToDB(app, obj));
        right.on("update-end", () => saveSongToDB(app, obj));

        blockEl.querySelector(".previewPlay").onclick = () => wave.play(left.end, right.start);
        blockEl.querySelector(".previewPause").onclick = () => wave.pause();

        titleInput.oninput = () => { obj.title = titleInput.value; saveSongToDB(app, obj); };

        app.songs.push(obj);
        saveSongToDB(app, obj);
    });
}

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

        // Manual save button (confidence click)
        const saveBtn = block.querySelector(".saveSongBtn");
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.onclick = async () => {
                const prev = saveBtn.textContent;
                saveBtn.textContent = "Saving...";
                try {
                    await saveSongToDB(app, obj);
                    saveBtn.textContent = "Saved!";
                    setTimeout(() => { saveBtn.textContent = prev; }, 700);
                } catch (e) {
                    console.error(e);
                    saveBtn.textContent = "Error";
                    setTimeout(() => { saveBtn.textContent = prev; }, 1000);
                }
            };
        }

        block.dataset.songId = saved.id;

        const titleInput = block.querySelector(".songTitle");
        titleInput.value = obj.title;
        titleInput.oninput = () => { obj.title = titleInput.value; saveSongToDB(app, obj); };

        block.querySelector(".previewPlay").onclick = () => wave.play(left.end, right.start);
        block.querySelector(".previewPause").onclick = () => wave.pause();

        left.on("update-end", () => saveSongToDB(app, obj));
        right.on("update-end", () => saveSongToDB(app, obj));

        app.songs.push(obj);
    });
}

function saveSongToDB(app, obj) {
    if (!app.db) return Promise.resolve(null);

    const rec = {
        name: obj.file.name,
        type: obj.file.type,
        data: obj.arrayBuffer,
        trimStart: obj.leftHandle.end,
        trimEnd: obj.rightHandle.start,
        title: obj.title
    };

    if (obj.id != null) rec.id = obj.id;

    return dbPut(app, "songs", rec)
        .then(id => {
            if (obj.id == null) {
                obj.id = id;
                if (obj.blockEl) obj.blockEl.dataset.songId = id;
            }
            return id;
        })
        .catch(err => {
            console.error(err);
            throw err;
        });
}

///////////////////////////////////////////////////////////////////////////////
// AUDIO GRAPH (music stereo split + mic injection)
///////////////////////////////////////////////////////////////////////////////
async function ensureAudioReady(app) {
    if (!app.audioCtx) app.audioCtx = new AudioContext();

    if (!app.beepBuffer) {
        try {
            const beepData = await fetch("beep.wav");
            const beepArrayBuf = await beepData.arrayBuffer();
            app.beepBuffer = await app.audioCtx.decodeAudioData(beepArrayBuf);
        } catch (e) {
            console.warn("Could not load beep.wav.", e);
        }
    }

    if (!app.graphReady) {
        buildCoachGraph(app);
    }
}

function buildCoachGraph(app) {
    const ctx = app.audioCtx;

    app.splitter = ctx.createChannelSplitter(2);
    app.merger = ctx.createChannelMerger(2);

    app.musicGainL = ctx.createGain();
    app.musicGainR = ctx.createGain();
    app.musicGainL.gain.value = 1.0;
    app.musicGainR.gain.value = 1.0;

    // mic chain
    app.micGain = ctx.createGain();
    app.micGain.gain.value = 0.0;

    // compressor for voice clarity (optional but helpful)
    app.micComp = ctx.createDynamicsCompressor();
    app.micComp.threshold.value = -24;
    app.micComp.knee.value = 24;
    app.micComp.ratio.value = 6;
    app.micComp.attack.value = 0.005;
    app.micComp.release.value = 0.08;

    // route music: splitter -> gains -> merger
    app.splitter.connect(app.musicGainL, 0);
    app.splitter.connect(app.musicGainR, 1);
    app.musicGainL.connect(app.merger, 0, 0);
    app.musicGainR.connect(app.merger, 0, 1);

    // route mic: micGain -> compressor -> merger (default right-only, configurable at connect time)
    app.micGain.connect(app.micComp);

    // output
    app.merger.connect(ctx.destination);

    app.graphReady = true;
}

///////////////////////////////////////////////////////////////////////////////
// BUILD FINAL TRACK (run music only — intro separate)
///////////////////////////////////////////////////////////////////////////////
async function buildTrack(app) {
    if (!app.songs || app.songs.length === 0) {
        alert("No songs loaded. Add at least one song first.");
        return;
    }

    await ensureAudioReady(app);

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
// MAIN WAVEFORM (VISUAL ONLY during runs)
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
        // During runs we mute WaveSurfer's audio to avoid doubling
        app.mainWave.setVolume(1.0);

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
// COACH TALK (hold-to-talk)
///////////////////////////////////////////////////////////////////////////////
async function ensureMic(app) {
    if (app.micStream && app.micSource) return;

    const ctx = app.audioCtx;

    // Request mic (this MUST be triggered by user gesture -> pointerdown)
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    });

    app.micStream = stream;
    app.micSource = ctx.createMediaStreamSource(stream);

    // Connect micSource -> micGain (sums into merger later)
    app.micSource.connect(app.micGain);

    // Connect compressor output to merger channels based on "right only" toggle
    connectMicToMerger(app);
}

function connectMicToMerger(app) {
    // clear any previous micComp connections (best-effort)
    try { app.micComp.disconnect(); } catch {}

    const rightOnly = app.root.querySelector(".coachRightOnly")?.checked ?? true;

    if (rightOnly) {
        // mic -> right channel only
        app.micComp.connect(app.merger, 0, 1);
    } else {
        // mic -> both channels
        app.micComp.connect(app.merger, 0, 0);
        app.micComp.connect(app.merger, 0, 1);
    }
}

async function coachStart(app) {
    await ensureAudioReady(app);

    // Ensure mic exists + routed properly
    try {
        await ensureMic(app);
    } catch (e) {
        alert("Mic permission denied or unavailable.");
        console.error(e);
        return;
    }

    // Update routing in case toggle changed
    connectMicToMerger(app);

    const duckAmt = parseFloat(app.root.querySelector(".coachDuck")?.value ?? "0.5");
    const coachBtn = app.root.querySelector(".coachHold");
    const status = app.root.querySelector(".coachStatusText");

    // Duck RIGHT ear music only while coaching
    if (app.musicGainR) app.musicGainR.gain.value = duckAmt;

    // Turn on mic
    if (app.micGain) app.micGain.gain.value = 1.0;
    app.micOn = true;

    if (coachBtn) coachBtn.classList.add("active");
    if (status) status.textContent = "ON";
}

async function coachStop(app) {
    const coachBtn = app.root.querySelector(".coachHold");
    const status = app.root.querySelector(".coachStatusText");

    // Restore music
    if (app.musicGainR) app.musicGainR.gain.value = 1.0;

    // Mute mic (keep stream alive so it’s instant next time)
    if (app.micGain) app.micGain.gain.value = 0.0;
    app.micOn = false;

    if (coachBtn) coachBtn.classList.remove("active");
    if (status) status.textContent = "OFF";
}

///////////////////////////////////////////////////////////////////////////////
// RUN PLAYBACK (OUR AUDIO) + WAVEFORM SYNC (MUTED WAVESURFER)
///////////////////////////////////////////////////////////////////////////////
async function startRun(app) {
    if (!app.lastCombinedBuffer || !app.mainWave) {
        alert("Build the track first.");
        return;
    }

    await ensureAudioReady(app);

    // Make sure WaveSurfer is muted during real playback (visual only)
    app.mainWave.setVolume(0);

    // Reset coach state
    if (app.micOn) await coachStop(app);

    // Stop any existing run
    stopRunSource(app);

    const starter = app.root.querySelector(".starterBeepToggle").checked;

    const introInfo = await getIntroDecodedInfo(app);
    const introDur = introInfo ? introInfo.trimmedSeconds : 0;

    // Play intro (WebAudio direct), duck last 3 seconds if starter on
    if (introInfo) {
        playIntroWithOptionalDuck(app, introInfo, starter);

        // Start main run exactly when intro ends
        setTimeout(() => {
            startMainRunAudio(app, 0);
            scheduleBeeps(app, introDur);
        }, Math.floor(introDur * 1000));

        // Starter beeps happen during the duck window (end of intro)
        if (starter) scheduleStarterBeepsAtEndOfIntro(app, introDur);

        return;
    }

    // No intro:
    if (starter) {
        // play starter beeps now, start run at t=3
        playBeepAfter(app, 0);
        playBeepAfter(app, 1);
        playBeepAfter(app, 2);

        setTimeout(() => {
            startMainRunAudio(app, 0);
            scheduleBeeps(app, 3);
        }, 3000);
    } else {
        startMainRunAudio(app, 0);
        scheduleBeeps(app, 0);
    }
}

function startMainRunAudio(app, offsetSec) {
    if (!app.lastCombinedBuffer) return;

    // Start WaveSurfer visual playback (muted)
    app.mainWave.seekTo(offsetSec / app.TIME_LIMIT);
    app.mainWave.play();

    // Start our real audio
    const ctx = app.audioCtx;

    const src = ctx.createBufferSource();
    src.buffer = app.lastCombinedBuffer;

    // music -> splitter -> (L/R gains) -> merger -> destination
    src.connect(app.splitter);

    app.runSource = src;
    app.runStartCtxTime = ctx.currentTime;
    app.runOffsetSec = offsetSec;
    app.runPlaying = true;

    // Ensure music gains are normal at start
    app.musicGainL.gain.value = 1.0;
    app.musicGainR.gain.value = 1.0;

    // If coach is held mid-run, it will duck right ear via coachStart()

    src.start(0, offsetSec);

    // When finished, reset
    src.onended = () => {
        if (app.runPlaying) {
            app.runPlaying = false;
            app.runSource = null;
            try { app.mainWave.pause(); } catch {}
        }
    };
}

function pauseRun(app) {
    if (!app.runPlaying) return;

    // Calculate current offset
    const ctx = app.audioCtx;
    const elapsed = ctx.currentTime - app.runStartCtxTime;
    const current = app.runOffsetSec + elapsed;

    stopRunSource(app);

    app.runOffsetSec = Math.min(current, app.TIME_LIMIT);
    app.runPlaying = false;

    // Pause visual
    if (app.mainWave) app.mainWave.pause();
}

function resumeRun(app) {
    if (app.runPlaying) return;
    if (!app.lastCombinedBuffer || !app.mainWave) return;

    // Continue from offset
    startMainRunAudio(app, app.runOffsetSec);
}

function restartRun(app) {
    stopRunSource(app);
    app.runOffsetSec = 0;
    app.runPlaying = false;

    if (app.mainWave) {
        app.mainWave.seekTo(0);
        app.mainWave.pause();
    }

    // restart immediately (no intro/starter logic here — restart means “restart run music”)
    startMainRunAudio(app, 0);
}

function stopRunSource(app) {
    if (app.runSource) {
        try { app.runSource.stop(); } catch {}
        try { app.runSource.disconnect(); } catch {}
    }
    app.runSource = null;
}

///////////////////////////////////////////////////////////////////////////////
// Beeps
///////////////////////////////////////////////////////////////////////////////
function scheduleBeeps(app, startOffsetSec = 0) {
    app.beepSecondsLeft.forEach(sec => {
        const t = startOffsetSec + (app.TIME_LIMIT - sec);
        setTimeout(() => playBeep(app), t * 1000);
    });
}

function playBeepAfter(app, t) {
    setTimeout(() => playBeep(app), t * 1000);
}

function playBeep(app) {
    if (!app.audioCtx || !app.beepBuffer) return;
    const src = app.audioCtx.createBufferSource();
    src.buffer = app.beepBuffer;
    src.connect(app.audioCtx.destination);
    src.start();
}

///////////////////////////////////////////////////////////////////////////////
// Intro playback with ducking
///////////////////////////////////////////////////////////////////////////////
async function getIntroDecodedInfo(app) {
    if (!app.intro || !app.intro.arrayBuffer) return null;
    await ensureAudioReady(app);

    if (!app.introDecoded) {
        const decoded = await decodeFixRate(app, app.intro.arrayBuffer);
        app.introDecoded = decoded;
    }

    const rate = app.audioCtx.sampleRate;

    const startSample = Math.floor(app.intro.leftHandle.end * rate);
    const endSample = Math.floor(app.intro.rightHandle.start * rate);
    const trimmedSamples = Math.max(0, endSample - startSample);

    if (trimmedSamples <= 0) return null;

    return {
        buffer: app.introDecoded,
        startSample,
        endSample,
        trimmedSeconds: trimmedSamples / rate
    };
}

function playIntroWithOptionalDuck(app, introInfo, starterOn) {
    stopIntroPlayback(app);

    const ctx = app.audioCtx;
    const rate = ctx.sampleRate;

    const src = ctx.createBufferSource();
    src.buffer = introInfo.buffer;

    const gain = ctx.createGain();
    gain.gain.value = 1.0;

    src.connect(gain).connect(ctx.destination);

    const startOffset = introInfo.startSample / rate;
    const duration = (introInfo.endSample - introInfo.startSample) / rate;

    const startTime = ctx.currentTime;
    src.start(startTime, startOffset, duration);

    if (starterOn) {
        const duckSeconds = Math.min(3, duration);
        const duckAt = startTime + (duration - duckSeconds);

        gain.gain.setValueAtTime(1.0, duckAt);
        gain.gain.linearRampToValueAtTime(0.75, duckAt + 0.03);
        gain.gain.setValueAtTime(0.75, startTime + duration);
    }

    app.introSources.push({ src, gain });
}

function scheduleStarterBeepsAtEndOfIntro(app, introDur) {
    // Beeps at introEnd-3, -2, -1 (if intro shorter than 3, they start at 0)
    const first = Math.max(0, introDur - Math.min(3, introDur));
    playBeepAfter(app, first + 0);
    playBeepAfter(app, first + 1);
    playBeepAfter(app, first + 2);
}

function stopIntroPlayback(app) {
    if (!app.introSources) app.introSources = [];
    app.introSources.forEach(s => { try { s.src.stop(); } catch {} });
    app.introSources = [];
}

///////////////////////////////////////////////////////////////////////////////
// EXPORT (unchanged in this step — still works with intro duck + beeps)
// If you want exports to include the coach mic overlays, that's doable too.
///////////////////////////////////////////////////////////////////////////////
async function exportTrack(app) {
    if (!app.lastCombinedBuffer) {
        alert("Build the track first.");
        return;
    }
    await ensureAudioReady(app);
    if (!app.beepBuffer) {
        alert("Beep sound not loaded. Please rebuild the track first.");
        return;
    }

    // This export remains: intro (duck last 3 sec if starter on) + run + beeps.
    // (Coach mic is live-only.)
    const starterOn = app.root.querySelector(".starterBeepToggle").checked;

    const introInfo = await getIntroDecodedInfo(app);
    const introDur = introInfo ? introInfo.trimmedSeconds : 0;
    const introDuckSeconds = (starterOn && introInfo) ? Math.min(3, introDur) : 0;

    const base = app.lastCombinedBuffer;
    const sr = base.sampleRate;
    const chs = base.numberOfChannels;

    const mainStart = introDur;
    const musicSeconds = base.length / sr;
    const totalSeconds = mainStart + musicSeconds;

    const out = app.audioCtx.createBuffer(chs, Math.floor(totalSeconds * sr), sr);

    // Intro mix (duck last section)
    if (introInfo) {
        const startS = introInfo.startSample;
        const endS = introInfo.endSample;
        const duckSamps = Math.floor(introDuckSeconds * sr);
        const duckStart = Math.max(startS, endS - duckSamps);

        mixBufferSegmentInto(out, introInfo.buffer, startS, duckStart, 0, 1.0);
        if (duckStart < endS) mixBufferSegmentInto(out, introInfo.buffer, duckStart, endS, (duckStart - startS), 0.75);
    }

    // Run music
    for (let ch = 0; ch < chs; ch++) {
        out.getChannelData(ch).set(base.getChannelData(ch), Math.floor(mainStart * sr));
    }

    // Starter beeps
    if (starterOn && introInfo) {
        const firstBeep = Math.max(0, introDur - introDuckSeconds);
        [0, 1, 2].forEach(t => mixBeepIntoBuffer(out, app.beepBuffer, firstBeep + t));
    } else if (starterOn && !introInfo) {
        [0, 1, 2].forEach(t => mixBeepIntoBuffer(out, app.beepBuffer, t));
    }

    // Timing beeps
    app.beepSecondsLeft.forEach(secLeft => {
        const t = mainStart + (app.TIME_LIMIT - secLeft);
        if (t >= 0 && t < totalSeconds) mixBeepIntoBuffer(out, app.beepBuffer, t);
    });

    const wav = audioBufferToWav(out);
    const blob = new Blob([wav], { type: "audio/wav" });

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

function mixBufferSegmentInto(destBuf, srcBuf, srcStartSample, srcEndSample, destStartSample, gain = 1.0) {
    const destCh = destBuf.numberOfChannels;
    const srcCh = srcBuf.numberOfChannels;

    const length = Math.min(srcEndSample - srcStartSample, destBuf.length - destStartSample);
    if (length <= 0) return;

    for (let ch = 0; ch < destCh; ch++) {
        const d = destBuf.getChannelData(ch);
        const s = srcBuf.getChannelData(ch < srcCh ? ch : 0);

        for (let i = 0; i < length; i++) {
            const di = destStartSample + i;
            const si = srcStartSample + i;
            let sample = d[di] + s[si] * gain;
            if (sample > 1) sample = 1;
            if (sample < -1) sample = -1;
            d[di] = sample;
        }
    }
}

function mixBeepIntoBuffer(destBuf, beepBuf, timeSec) {
    const sr = destBuf.sampleRate;
    const startSample = Math.floor(timeSec * sr);

    const destChannels = destBuf.numberOfChannels;
    const beepChannels = beepBuf.numberOfChannels;

    for (let i = 0; i < beepBuf.length; i++) {
        const di = startSample + i;
        if (di >= destBuf.length) break;

        for (let ch = 0; ch < destChannels; ch++) {
            const srcCh = ch < beepChannels ? ch : 0;
            const d = destBuf.getChannelData(ch);
            const s = beepBuf.getChannelData(srcCh);

            let sample = d[di] + s[i];
            if (sample > 1) sample = 1;
            if (sample < -1) sample = -1;
            d[di] = sample;
        }
    }
}

function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;

    const samples = buffer.length;
    const blockAlign = numChannels * bitDepth / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples * blockAlign;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    let offset = 0;

    function writeString(str) {
        for (let i = 0; i < str.length; i++) view.setUint8(offset++, str.charCodeAt(i));
    }

    writeString("RIFF");
    view.setUint32(offset, 36 + dataSize, true); offset += 4;
    writeString("WAVE");

    writeString("fmt ");
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, format, true); offset += 2;
    view.setUint16(offset, numChannels, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, byteRate, true); offset += 4;
    view.setUint16(offset, blockAlign, true); offset += 2;
    view.setUint16(offset, bitDepth, true); offset += 2;

    writeString("data");
    view.setUint32(offset, dataSize, true); offset += 4;

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

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
