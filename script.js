///////////////////////////////////////////////////////////////////////
// NSC Music Timer — with delete, reorder, rename,
// thicker handles, dark mode — WaveSurfer v6
///////////////////////////////////////////////////////////////////////

let audioCtx = null;
let beepBuffer = null;

let songs = [];        // Array of song objects in UI order
let mainWave = null;
let lastCombinedBuffer = null;

let db = null;

let beepSecondsLeft = [180,120,60,30,10];
let TIME_LIMIT = 240;

///////////////////////////////////////////////////////////////////////
// INIT
///////////////////////////////////////////////////////////////////////
window.addEventListener("load", async () => {
    await initDB();
    await loadSettingsFromDB();
    await loadSongsFromDB();

    wireButtons();
    enableDragReorder();
});

function wireButtons() {
    document.getElementById("addSong").onclick = addSongBlock;
    document.getElementById("buildTrack").onclick = buildTrack;
    document.getElementById("startRun").onclick = startRun;

    document.getElementById("pauseBtn").onclick = () => mainWave?.pause();
    document.getElementById("resumeBtn").onclick = () => mainWave?.play();
    document.getElementById("restartBtn").onclick = () => {
        if(mainWave){ mainWave.seekTo(0); mainWave.play(); }
    };

    document.getElementById("saveTimeLimit").onclick = () => {
        const min = parseFloat(document.getElementById("timeLimit").value);
        if(!isNaN(min)){ TIME_LIMIT = min*60; saveSettingsToDB(); }
    };

    document.getElementById("darkSwitch").onchange = () => {
        document.documentElement.classList.toggle("dark");
        saveSettingsToDB();
    };

    document.getElementById("addBeep").onclick = () => {
        beepSecondsLeft.push(60);
        renderBeepInputs();
        saveSettingsToDB();
    };

    document.getElementById("saveBeeps").onclick = () => {
        beepSecondsLeft = Array.from(
            document.querySelectorAll("#beepList input")
        ).map(v => Number(v.value));
        saveSettingsToDB();
        if(lastCombinedBuffer) makeMainWaveform(lastCombinedBuffer);
    };
}

///////////////////////////////////////////////////////////////////////
// IndexedDB
///////////////////////////////////////////////////////////////////////
function initDB() {
    return new Promise(res=>{
        const req = indexedDB.open("nsc-timer-db",5);
        req.onupgradeneeded=e=>{
            const db=e.target.result;
            if(!db.objectStoreNames.contains("songs"))
                db.createObjectStore("songs",{keyPath:"id",autoIncrement:true});
            if(!db.objectStoreNames.contains("settings"))
                db.createObjectStore("settings",{keyPath:"key"});
        };
        req.onsuccess=e=>{ db=e.target.result; res(); };
    });
}

function dbPut(store,value){
    return new Promise(res=>{
        const tx=db.transaction([store],"readwrite");
        tx.objectStore(store).put(value).onsuccess=res;
    });
}

function dbGetAll(store){
    return new Promise(res=>{
        const tx=db.transaction([store]);
        const q=tx.objectStore(store).getAll();
        q.onsuccess=()=>res(q.result||[]);
    });
}

function dbGet(store,key){
    return new Promise(res=>{
        const tx=db.transaction([store]);
        const q=tx.objectStore(store).get(key);
        q.onsuccess=()=>res(q.result||null);
    });
}

///////////////////////////////////////////////////////////////////////
// Settings Load/Save
///////////////////////////////////////////////////////////////////////
async function loadSettingsFromDB() {
    const s=await dbGet("settings","main");
    if(!s) return;

    beepSecondsLeft = s.beepTimes ?? beepSecondsLeft;
    TIME_LIMIT = s.timeLimit ?? TIME_LIMIT;

    document.getElementById("starterBeepToggle").checked = !!s.starterBeep;
    document.getElementById("darkSwitch").checked = !!s.darkMode;

    if(s.darkMode) document.documentElement.classList.add("dark");

    document.getElementById("timeLimit").value = (TIME_LIMIT/60).toFixed(2);
}

function saveSettingsToDB() {
    dbPut("settings",{
        key:"main",
        beepTimes:beepSecondsLeft,
        starterBeep:document.getElementById("starterBeepToggle").checked,
        timeLimit:TIME_LIMIT,
        darkMode:document.getElementById("darkSwitch").checked
    });
}

///////////////////////////////////////////////////////////////////////
// Load Songs
///////////////////////////////////////////////////////////////////////
async function loadSongsFromDB(){
    const stored=await dbGetAll("songs");
    for(const s of stored) await restoreSongFromDB(s);
    renderBeepInputs();
}

///////////////////////////////////////////////////////////////////////
// Add Song Block
///////////////////////////////////////////////////////////////////////
function addSongBlock() {
    const container=document.getElementById("songContainer");
    const id="wave-"+Math.random().toString(36).slice(2);

    const div=document.createElement("div");
    div.className="song-block";
    div.dataset.songId="0";

    div.innerHTML=`
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

    div.querySelector(".deleteSong").onclick = () => deleteSong(div);

    div.querySelector(".song-file").onchange = e=>{
        if(e.target.files.length>0)
            loadNewSong(e.target.files[0],id,div);
    };

    return div;
}

///////////////////////////////////////////////////////////////////////
// Delete song
///////////////////////////////////////////////////////////////////////
function deleteSong(blockEl){
    const idx=[...blockEl.parentNode.children].indexOf(blockEl);
    songs.splice(idx,1);
    blockEl.remove();
    saveAllSongsToDB();
}
////////////////////////

function renderBeepInputs() {
    const list = document.getElementById("beepList");
    list.innerHTML = "";

    beepSecondsLeft.forEach((sec, i) => {
        const div = document.createElement("div");
        div.innerHTML = `
            <input type="number" value="${sec}">
            <button onclick="removeBeep(${i})">X</button>
        `;
        list.appendChild(div);
    });
}

function removeBeep(i) {
    beepSecondsLeft.splice(i, 1);
    renderBeepInputs();
    saveSettingsToDB();
}

///////////////////////////////////////////////////////////////////////
// Save all songs (after reorder/delete)
///////////////////////////////////////////////////////////////////////
function saveAllSongsToDB(){
    // wipe store
    const tx=db.transaction(["songs"],"readwrite");
    tx.objectStore("songs").clear().onsuccess = ()=>{
        // reinsert in UI order
        songs.forEach(s=>saveSongToDB(s));
    };
}

///////////////////////////////////////////////////////////////////////
// Drag Reorder
///////////////////////////////////////////////////////////////////////
function enableDragReorder(){
    new Sortable(songContainer,{
        animation:150,
        onEnd:()=>{
            // reorder internal array to match DOM
            const blocks=[...document.querySelectorAll(".song-block")];
            songs = blocks.map(b=>{
                const id=b.dataset.songId;
                return songs.find(s=>s.id==id);
            }).filter(x=>x); // remove nulls
            saveAllSongsToDB();
        }
    });
}

///////////////////////////////////////////////////////////////////////
// Load NEW song
///////////////////////////////////////////////////////////////////////
function loadNewSong(file,waveId,blockEl){
    const wave = WaveSurfer.create({
        container:"#"+waveId,
        waveColor:"#33aaff",
        progressColor:"#77ddff",
        height:120,
        plugins:[ WaveSurfer.regions.create({}) ]
    });

    wave.loadBlob(file);

    wave.on("ready",async()=>{
        const dur=wave.getDuration();

        const left=wave.addRegion({
            start:0, end:0.4,
            drag:false, resize:true,
            color:"rgba(255,0,0,0.18)"
        });

        const right=wave.addRegion({
            start:dur-0.4, end:dur,
            drag:false, resize:true,
            color:"rgba(0,255,0,0.18)"
        });

        const buffer=await file.arrayBuffer();

        const titleInput = blockEl.querySelector(".songTitle");

        const obj={
            id:null,
            file,
            wave,
            leftHandle:left,
            rightHandle:right,
            arrayBuffer:buffer,
            title:titleInput.value || file.name
        };

        blockEl.dataset.songId = "NEW";

        left.on("update-end",()=>saveSongToDB(obj));
        right.on("update-end",()=>saveSongToDB(obj));

        blockEl.querySelector(".previewPlay").onclick = ()=>wave.play(left.end,right.start);
        blockEl.querySelector(".previewPause").onclick = ()=>wave.pause();

        titleInput.oninput = ()=>{ obj.title = titleInput.value; saveSongToDB(obj); };

        saveSongToDB(obj);
        songs.push(obj);
    });
}

///////////////////////////////////////////////////////////////////////
// Restore from DB
///////////////////////////////////////////////////////////////////////
async function restoreSongFromDB(saved){
    const block=addSongBlock();
    const waveId=block.querySelector(".wave").id;

    const file=new File([saved.data],saved.name,{type:saved.type});

    const wave=WaveSurfer.create({
        container:"#"+waveId,
        waveColor:"#33aaff",
        progressColor:"#77ddff",
        height:120,
        plugins:[ WaveSurfer.regions.create({}) ]
    });

    wave.loadBlob(file);

    wave.on("ready",()=>{
        const dur=wave.getDuration();

        const left=wave.addRegion({
            start:0,
            end:saved.trimStart,
            drag:false,
            resize:true,
            color:"rgba(255,0,0,0.18)"
        });
        const right=wave.addRegion({
            start:saved.trimEnd,
            end:dur,
            drag:false,
            resize:true,
            color:"rgba(0,255,0,0.18)"
        });

        const obj={
            id:saved.id,
            file,
            wave,
            leftHandle:left,
            rightHandle:right,
            arrayBuffer:saved.data,
            title:saved.title||saved.name
        };

        block.dataset.songId = saved.id;

        const titleInput = block.querySelector(".songTitle");
        titleInput.value = obj.title;
        titleInput.oninput = ()=>{ obj.title=titleInput.value; saveSongToDB(obj); };

        block.querySelector(".previewPlay").onclick = ()=>wave.play(left.end,right.start);
        block.querySelector(".previewPause").onclick = ()=>wave.pause();

        left.on("update-end",()=>saveSongToDB(obj));
        right.on("update-end",()=>saveSongToDB(obj));

        songs.push(obj);
    });
}

///////////////////////////////////////////////////////////////////////
// Save Song
///////////////////////////////////////////////////////////////////////
function saveSongToDB(obj){
    const rec={
        name:obj.file.name,
        type:obj.file.type,
        data:obj.arrayBuffer,
        trimStart:obj.leftHandle.end,
        trimEnd:obj.rightHandle.start,
        title:obj.title
    };
    if(obj.id) rec.id=obj.id;

    dbPut("songs",rec).then(async()=>{
        if(!obj.id){
            const all=await dbGetAll("songs");
            const m=all.find(x=>x.name===rec.name && x.trimStart===rec.trimStart);
            if(m) obj.id=m.id;
        }
    });
}

///////////////////////////////////////////////////////////////////////
// Build Track
///////////////////////////////////////////////////////////////////////
async function buildTrack(){
    audioCtx=new AudioContext();

    const beepData=await fetch("beep.wav");
    beepBuffer=await audioCtx.decodeAudioData(await beepData.arrayBuffer());

    const RUN=TIME_LIMIT;
    const rate=audioCtx.sampleRate;
    const final=audioCtx.createBuffer(2,RUN*rate,rate);

    let offset=0;

    for(let s of songs){
        const decoded=await decodeFixRate(s.arrayBuffer);

        const L=Math.floor(s.leftHandle.end*rate);
        const R=Math.floor(s.rightHandle.start*rate);

        const length=R-L;
        const rem=(RUN*rate)-offset;
        const copy=Math.min(length,rem);

        for(let ch=0;ch<decoded.numberOfChannels;ch++){
            final.getChannelData(ch).set(
                decoded.getChannelData(ch).slice(L,L+copy),
                offset
            );
        }
        offset += copy;
        if(offset>=RUN*rate) break;
    }

    lastCombinedBuffer=final;
    makeMainWaveform(final);

    document.getElementById("startRun").disabled=false;
    alert("Track built!");
}

async function decodeFixRate(buf){
    const original=await audioCtx.decodeAudioData(buf);
    if(original.sampleRate===audioCtx.sampleRate) return original;

    const off=new OfflineAudioContext(
        original.numberOfChannels,
        original.duration*audioCtx.sampleRate,
        audioCtx.sampleRate
    );
    const src=off.createBufferSource();
    src.buffer=original;
    src.connect(off.destination);
    src.start();
    return off.startRendering();
}

///////////////////////////////////////////////////////////////////////
// Make Final Waveform
///////////////////////////////////////////////////////////////////////
function makeMainWaveform(buffer){
    if(mainWave) mainWave.destroy();

    mainWave = WaveSurfer.create({
        container:"#mainWaveform",
        waveColor:"#44dd66",
        progressColor:"#66ff88",
        height:150,
        plugins:[ WaveSurfer.timeline.create({container:"#mainTimeline"}) ]
    });

    mainWave.loadDecodedBuffer(buffer);

    mainWave.on("ready",()=>{
        const drawer=mainWave.drawer;
        beepSecondsLeft.forEach(sec=>{
            const t=TIME_LIMIT-sec;
            const x=drawer.width*(t/TIME_LIMIT);

            const ctx=drawer.canvasContext;
            ctx.save();
            ctx.strokeStyle="rgba(255,0,0,0.9)";
            ctx.lineWidth=2;
            ctx.beginPath();
            ctx.moveTo(x,0);
            ctx.lineTo(x,drawer.height);
            ctx.stroke();
            ctx.restore();
        });
    });
}

///////////////////////////////////////////////////////////////////////
// Run Start
///////////////////////////////////////////////////////////////////////
function startRun(){
    if(!mainWave) return;

    const starter=document.getElementById("starterBeepToggle").checked;

    if(starter){
        playAfter(0); playAfter(1); playAfter(2);

        setTimeout(()=>{
            mainWave.seekTo(0);
            mainWave.play();
            scheduleBeeps();
        },4000);

    } else {
        mainWave.seekTo(0);
        mainWave.play();
        scheduleBeeps();
    }
}

function playAfter(t){
    setTimeout(()=>playBeep(),t*1000);
}

function scheduleBeeps(){
    beepSecondsLeft.forEach(sec=>{
        const t=TIME_LIMIT-sec;
        setTimeout(()=>playBeep(),t*1000);
    });
}

function playBeep(){
    const src=audioCtx.createBufferSource();
    src.buffer=beepBuffer;
    src.connect(audioCtx.destination);
    src.start();
}
