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

function dbPut(app, store, value) {
    return new Promise(res => {
        const tx = app.db.transaction([store], "readwrite");
        tx.objectStore(store).put(value).onsuccess = res;
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
    });
}

///////////////////////////////////////////////////////////////////////////////
// WIRES BUTTONS PER INSTANCE
///////////////////////////////////////////////////////////////////////////////
function wireButtons(app) {
    const r = app.root;

    r.querySelector(".addSong").onclick = () => addSongBlock(app);
    r.querySelector(".buildTrack").onclick = () => buildTrack(app);
    r.querySelector(".startRun").onclick = () => startRun(app);

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
    for (const s of stored) await restoreSongFromDB(app, s);
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
    app.songs.splice(idx, 1);
    blockEl.remove();
    saveAllSongsToDB(app);
}

///////////////////////////////////////////////////////////////////////////////
// SAVE ALL SONGS AFTER REORDER/DELETE
///////////////////////////////////////////////////////////////////////////////
function saveAllSongsToDB(app) {
    const tx = app.db.transaction(["songs"], "readwrite");
    tx.objectStore("songs").clear().onsuccess = () => {
        app.songs.forEach(s => saveSongToDB(app, s));
    };
}

///////////////////////////////////////////////////////////////////////////////
// DRAG REORDER
///////////////////////////////////////////////////////////////////////////////
function enableDragReorder(app) {
    new Sortable(app.root.querySelector(".songContainer"), {
        animation: 150,
        onEnd: () => {
            const blocks = [...app.root.querySelectorAll(".song-block")];
            app.songs = blocks.map(b => {
                const id = b.dataset.songId;
                return app.songs.find(s => s.id == id);
            }).filter(x => x);
            saveAllSongsToDB(app);
        }
    });
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
            title: titleInput.value || file.name
        };

        blockEl.dataset.songId = "NEW";

        left.on("update-end", () => saveSongToDB(app, obj));
        right.on("update-end", () => saveSongToDB(app, obj));

        blockEl.querySelector(".previewPlay").onclick =
            () => wave.play(left.end, right.start);

        blockEl.querySelector(".previewPause").onclick =
            () => wave.pause();

        titleInput.oninput = () => { obj.title = titleInput.value; saveSongToDB(app, obj); };

        saveSongToDB(app, obj);
        app.songs.push(obj);
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
            title: saved.title || saved.name
        };

        block.dataset.songId = saved.id;

        const titleInput = block.querySelector(".songTitle");
        titleInput.value = obj.title;
        titleInput.oninput = () => { obj.title = titleInput.value; saveSongToDB(app, obj); };

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
    const rec = {
        name: obj.file.name,
        type: obj.file.type,
        data: obj.arrayBuffer,
        trimStart: obj.leftHandle.end,
        trimEnd: obj.rightHandle.start,
        title: obj.title
    };
    if (obj.id) rec.id = obj.id;

    dbPut(app, "songs", rec).then(async () => {
        if (!obj.id) {
            const all = await dbGetAll(app, "songs");
            const match = all.find(x =>
                x.name === rec.name &&
                x.trimStart === rec.trimStart
            );
            if (match) obj.id = match.id;
        }
    });
}

///////////////////////////////////////////////////////////////////////////////
// BUILD FINAL TRACK
///////////////////////////////////////////////////////////////////////////////
async function buildTrack(app) {
    app.audioCtx = new AudioContext();

    const beepData = await fetch("beep.wav");
    app.beepBuffer = await app.audioCtx.decodeAudioData(await beepData.arrayBuffer());

    const RUN = app.TIME_LIMIT;
    const rate = app.audioCtx.sampleRate;
    const final = app.audioCtx.createBuffer(2, RUN * rate, rate);

    let offset = 0;

    for (let s of app.songs) {
        const decoded = await decodeFixRate(app, s.arrayBuffer);

        const L = Math.floor(s.leftHandle.end * rate);
        const R = Math.floor(s.rightHandle.start * rate);

        const length = R - L;
        const rem = (RUN * rate) - offset;
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
        }, 4000);

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
    const src = app.audioCtx.createBufferSource();
    src.buffer = app.beepBuffer;
    src.connect(app.audioCtx.destination);
    src.start();
}
