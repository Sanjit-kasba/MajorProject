import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ---------- TWEAK ME ---------- */
const CFG = {
    model: 'avaturn.glb',
    fov: 30,
    distance: 1.55,        // camera distance (bigger = more zoomed out)
    lookAtOffset: -0.12,   // camera aim, relative to the Head bone height
    tableDrop: -0.46,      // table-top height, relative to the Head bone height (more negative = lower table)
    minWidth: 1.05,        // narrowest scene width (m) kept in view on tall/narrow screens
    envIntensity: 0.55,    // reflection/ambient strength on the avatar
    lipGain: 7,            // voice loudness -> mouth opening
    silence: 0.012,        // voice level below this = mouth closed
    jaw: 0.45,             // max jawOpen
    mouth: 0.2,            // max mouthOpen
    viseme: 0.7,           // vowel shape strength
    tableBack: 0.2,        // distance of the table's near edge in front of her chest
    armDown: 70,           // upper arms: degrees down from the T-pose
    armForward: 30,        // upper arms: degrees swung forward
    elbowBend: 45,         // forearms: degrees bent forward
    handsIn: 25,           // forearms: degrees turned toward the centre
    sway: 1.0,             // head movement amount (0 = still)
    nodSign: 1,            // flip to -1 if the listening nod looks like a head-back
    useEyeBones: false     // also rotate the eye bones when looking around
};

const NAMES = ['jawOpen', 'mouthOpen', 'mouthFunnel', 'mouthPucker', 'mouthSmile',
    'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U',
    'eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
    'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight'];
const MOUTH = new Set(['jawOpen', 'mouthOpen', 'mouthFunnel', 'mouthPucker', 'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U']);
const BLINK = new Set(['eyeBlinkLeft', 'eyeBlinkRight']);
const VOWELS = ['viseme_aa', 'viseme_O', 'viseme_E', 'viseme_I', 'viseme_aa', 'viseme_U'];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------- state ---------- */
let stage, renderer, scene, camera, model, clock, rafId = 0, initPromise = null, ready = false;
let state = 'LISTENING', t = 0;
const slots = {}, cur = {}, tgt = {}, bones = {}, base = {};
NAMES.forEach(n => { slots[n] = []; cur[n] = 0; tgt[n] = 0; });

// audio / lip sync
let actx = null, analyser = null, tdata = null, fdata = null, centroid = 900, srcNode = null, audioActive = false, timedOn = false;
// idle
let nextBlink = 2, blinkStart = -1, nextNod = 5, nodStart = -1, nextGaze = 1.5, gaze = { x: 0, y: 0 }, gazeT = { x: 0, y: 0 };

const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _off = new THREE.Quaternion(), _e = new THREE.Euler();

/* ---------- scene helpers ---------- */
function woodTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#7a4a26'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 90; i++) {
        const y = Math.random() * 512, h = 1 + Math.random() * 5;
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '40,20,8' : '150,100,55'},${0.08 + Math.random() * 0.18})`;
        g.beginPath(); g.moveTo(0, y);
        for (let x = 0; x <= 512; x += 64) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 3);
        g.lineTo(512, y + h); g.lineTo(0, y + h); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(2, 1);
    return tex;
}

function wallTexture() {
    const c = document.createElement('canvas'); c.width = 8; c.height = 256;
    const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#2b3347'); grad.addColorStop(1, '#4a566e');
    g.fillStyle = grad; g.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function buildRoom(headY) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 5),
        new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 1 }));
    wall.position.set(0, headY, -1.1); scene.add(wall);

    const tableY = headY + CFG.tableDrop;
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.9),
        new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.55, metalness: 0.05 }));
    table.position.set(0, tableY - 0.8, CFG.tableBack + 0.45); // sits in front of her; its near edge hides everything below the chest
    scene.add(table);

    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x332211, 0.35));
    const key = new THREE.DirectionalLight(0xfff1e0, 1.8); key.position.set(1.2, headY + 0.8, 2); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9db4ff, 0.7); fill.position.set(-1.5, headY, 1.5); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2); rim.position.set(0, headY + 1, -1.5); scene.add(rim);
}

function resize() {
    if (!stage || !renderer) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const need = CFG.minWidth / 2 / (Math.tan(THREE.MathUtils.degToRad(CFG.fov) / 2) * camera.aspect);
    camera.position.z = Math.max(CFG.distance, need);
    camera.updateProjectionMatrix();
    if (camera.userData.target) camera.lookAt(camera.userData.target);
}

/* ---------- init ---------- */
function init(stageEl, onProgress) {
    if (initPromise) return initPromise;
    stage = stageEl;
    initPromise = new Promise(resolve => {
        const fail = err => {
            console.error('Avatar unavailable:', err);
            if (window.Avatar) window.Avatar.lastError = String((err && err.message) || err);
            cancelAnimationFrame(rafId);
            if (renderer) { renderer.dispose(); renderer.domElement.remove(); }
            renderer = null; ready = false; initPromise = null;
            resolve(false);
        };
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.setClearColor(0x0f172a);
            renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
            stage.appendChild(renderer.domElement);

            scene = new THREE.Scene();
            const pmrem = new THREE.PMREMGenerator(renderer);
            scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
            camera = new THREE.PerspectiveCamera(CFG.fov, 16 / 9, 0.05, 20);
            clock = new THREE.Clock();
        } catch (e) { fail(e); return; }

        new GLTFLoader().load(CFG.model, gltf => {
            try {
                model = gltf.scene; scene.add(model);
                model.traverse(o => {
                    if (!o.isMesh) return;
                    o.frustumCulled = false;
                    [].concat(o.material).forEach(m => { if (m && 'envMapIntensity' in m) m.envMapIntensity = CFG.envIntensity; });
                    if (o.morphTargetDictionary && o.morphTargetInfluences) {
                        NAMES.forEach(n => {
                            const i = o.morphTargetDictionary[n];
                            if (i !== undefined) slots[n].push([o.morphTargetInfluences, i]);
                        });
                    }
                });
                ['Head', 'Neck', 'Spine', 'Spine1', 'Spine2', 'LeftEye', 'RightEye', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm'].forEach(n => {
                    const b = model.getObjectByName(n);
                    if (b) { bones[n] = b; base[n] = b.quaternion.clone(); }
                });
                model.updateMatrixWorld(true);
                poseArms();
                model.updateMatrixWorld(true);
                const headY = bones.Head ? bones.Head.getWorldPosition(new THREE.Vector3()).y : 1.55;
                buildRoom(headY);
                camera.position.set(0, headY - 0.02, CFG.distance);
                camera.userData.target = new THREE.Vector3(0, headY + CFG.lookAtOffset, 0);
                new ResizeObserver(resize).observe(stage);
                resize();
                ready = true;
                clock.start(); loop();
                resolve(true);
            } catch (e) { fail(e); }
        }, ev => { if (onProgress && ev.total) onProgress(Math.round(ev.loaded / ev.total * 100)); }, fail);
    });
    return initPromise;
}

/* ---------- audio / lip sync ---------- */
function ensureCtx() {
    if (!actx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        actx = new AC();
        analyser = actx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.5;
        analyser.connect(actx.destination);
        tdata = new Float32Array(analyser.fftSize); fdata = new Float32Array(analyser.frequencyBinCount);
    }
    return actx;
}
function unlockAudio() { const c = ensureCtx(); if (c && c.state === 'suspended') c.resume().catch(() => {}); }

// Returns true if the audio is routed through the analyser (real lip sync); false = caller should use timed mouth.
function attachAudio(el) {
    detachAudio();
    const c = ensureCtx();
    if (!c) return false;
    if (c.state === 'suspended') c.resume().catch(() => {});
    if (c.state !== 'running') return false; // routing through a suspended context would mute the voice
    try {
        srcNode = c.createMediaElementSource(el);
        srcNode.connect(analyser);
        audioActive = true;
        return true;
    } catch (e) { console.warn('Lip-sync analyser unavailable:', e); return false; }
}
function detachAudio() {
    audioActive = false; timedOn = false;
    if (srcNode) { try { srcNode.disconnect(); } catch (_) {} srcNode = null; }
}

const tri = (x, a, b, c) => (x <= a || x >= c) ? 0 : x < b ? (x - a) / (b - a) : (c - x) / (c - b);

function mouthTargets() {
    let level = 0, vowel = null;
    if (audioActive && analyser) {
        // loudness from the waveform (RMS): quiet = closed mouth, loud = open
        analyser.getFloatTimeDomainData(tdata);
        let sum = 0; for (let i = 0; i < tdata.length; i++) sum += tdata[i] * tdata[i];
        level = clamp((Math.sqrt(sum / tdata.length) - CFG.silence) * CFG.lipGain);
        if (level > 0.02) { // vowel shape from the spectral centroid (where the sound energy sits)
            analyser.getFloatFrequencyData(fdata);
            const hz = actx.sampleRate / analyser.fftSize;
            let num = 0, den = 0;
            for (let i = Math.ceil(200 / hz), end = Math.floor(4500 / hz); i <= end; i++) { const m = Math.pow(10, fdata[i] / 20); num += m * i * hz; den += m; }
            if (den > 0) centroid += (num / den - centroid) * 0.35;
        }
    } else if (timedOn) {
        const s = t * 7.5, idx = Math.floor(s), ph = s - idx;
        const pseudo = (Math.sin(idx * 12.9898) * 43758.5453) % 1;
        level = Math.sin(Math.PI * ph) * (Math.sin(t * 0.9) > -0.75 ? 1 : 0.15) * (0.55 + 0.45 * Math.abs(pseudo));
        vowel = VOWELS[idx % VOWELS.length];
    }
    if (level < 0.02) return 0;
    tgt.jawOpen = level * CFG.jaw;
    tgt.mouthOpen = level * CFG.mouth;
    const v = CFG.viseme;
    if (vowel) tgt[vowel] = level * v;
    else {
        const c = centroid;
        const w = { viseme_U: tri(c, 200, 350, 520) * 0.6, viseme_O: tri(c, 400, 600, 850) * 0.7, viseme_aa: Math.max(tri(c, 650, 1000, 1600), 0.25),
                    viseme_E: tri(c, 1200, 1750, 2500), viseme_I: tri(c, 1900, 2800, 5000) };
        const tot = w.viseme_U + w.viseme_O + w.viseme_aa + w.viseme_E + w.viseme_I;
        for (const k in w) tgt[k] = level * (w[k] / tot) * v * 1.3;
    }
    tgt.mouthFunnel = tgt.viseme_O * 0.25;
    tgt.mouthPucker = tgt.viseme_U * 0.3;
    return level;
}

/* ---------- animation ---------- */
// Rotate a bone by a WORLD-space offset (independent of the rig's local axes).
function offsetBone(name, pitch, yaw, roll, k = 1) {
    _e.set(pitch * k, yaw * k, roll * k, 'YXZ'); _off.setFromEuler(_e);
    offsetBoneQ(name, _off);
}
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const rotQ = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(AX[axis], THREE.MathUtils.degToRad(deg));
// T-pose -> relaxed seated pose, forearms resting on the table
function poseArms() {
    for (const [side, s] of [['Left', 1], ['Right', -1]]) {
        offsetBoneQ(`${side}Arm`, rotQ('x', -CFG.armForward).multiply(rotQ('z', -s * CFG.armDown)));
        offsetBoneQ(`${side}ForeArm`, rotQ('y', -s * CFG.handsIn).multiply(rotQ('x', -CFG.elbowBend)));
    }
}
function offsetBoneQ(name, off) {
    const b = bones[name]; if (!b) return;
    _off.copy(off);
    b.parent.getWorldQuaternion(_pq);
    _q.copy(_pq).invert().multiply(_off).multiply(_pq).multiply(base[name]);
    b.quaternion.copy(_q);
}

function frame(dt) {
    NAMES.forEach(n => { tgt[n] = 0; });
    const speaking = state === 'SPEAKING', thinking = state === 'PROCESSING';
    const level = mouthTargets();

    // blinking
    if (blinkStart < 0 && t > nextBlink) blinkStart = t;
    if (blinkStart >= 0) {
        const p = (t - blinkStart) / 0.18;
        if (p >= 1) { blinkStart = -1; nextBlink = t + rand(2, 6); }
        else tgt.eyeBlinkLeft = tgt.eyeBlinkRight = Math.sin(Math.PI * p);
    }

    // gaze
    if (t > nextGaze) {
        nextGaze = t + rand(1.2, 3.5);
        gazeT = Math.random() < 0.6 ? { x: 0, y: 0 } : { x: rand(-0.3, 0.3), y: rand(-0.2, 0.2) };
    }
    const gt = thinking ? { x: Math.sin(t * 0.7) * 0.3, y: 0.6 } : gazeT;
    const gk = 1 - Math.exp(-8 * dt);
    gaze.x += (gt.x - gaze.x) * gk; gaze.y += (gt.y - gaze.y) * gk;
    const gx = gaze.x, gy = gaze.y; // gx > 0 = avatar looks to its left
    tgt.eyeLookOutLeft = clamp(gx); tgt.eyeLookInRight = clamp(gx);
    tgt.eyeLookInLeft = clamp(-gx); tgt.eyeLookOutRight = clamp(-gx);
    tgt.eyeLookUpLeft = tgt.eyeLookUpRight = clamp(gy);
    tgt.eyeLookDownLeft = tgt.eyeLookDownRight = clamp(-gy);

    // face
    if (thinking) { tgt.browInnerUp = 0.4; tgt.browOuterUpLeft = tgt.browOuterUpRight = 0.25; tgt.mouthSmile = 0; }
    else if (speaking) { tgt.browInnerUp = 0.1 + level * 0.25; tgt.browOuterUpLeft = tgt.browOuterUpRight = level * 0.15; tgt.mouthSmile = 0.06; }
    else { tgt.browInnerUp = 0.12; tgt.mouthSmile = 0.14; }

    // smooth + apply
    for (const n of NAMES) {
        const up = BLINK.has(n) ? 45 : MOUTH.has(n) ? 30 : 6, down = BLINK.has(n) ? 45 : MOUTH.has(n) ? 16 : 6;
        cur[n] += (tgt[n] - cur[n]) * (1 - Math.exp(-(tgt[n] > cur[n] ? up : down) * dt));
        for (const [infl, i] of slots[n]) infl[i] = cur[n];
    }

    // body / head motion
    const amp = (speaking ? 1 : thinking ? 0.5 : 0.6) * CFG.sway;
    let yaw = (0.05 * Math.sin(t * 0.6) + 0.03 * Math.sin(t * 1.3 + 1)) * amp;
    let pitch = 0.03 * Math.sin(t * 0.9 + 2) * amp + (speaking ? level * 0.04 * CFG.nodSign : 0);
    let roll = 0.02 * Math.sin(t * 0.5) * amp + (thinking ? 0.05 * CFG.sway : 0);
    if (state === 'LISTENING') {
        if (nodStart < 0 && t > nextNod) nodStart = t;
        if (nodStart >= 0) {
            const p = (t - nodStart) / 0.9;
            if (p >= 1) { nodStart = -1; nextNod = t + rand(4, 8); }
            else pitch += 0.07 * Math.sin(Math.PI * p) * CFG.nodSign * CFG.sway;
        }
    }
    const br = 0.008 * Math.sin(t * 1.5);
    offsetBone('Spine', br, 0, 0); offsetBone('Spine1', br, 0, 0); offsetBone('Spine2', br, 0, 0);
    offsetBone('Neck', pitch, yaw, roll, 0.4);
    offsetBone('Head', pitch, yaw, roll, 0.6);
    if (CFG.useEyeBones) {
        offsetBone('LeftEye', -gy * 0.25, gx * 0.35, 0);
        offsetBone('RightEye', -gy * 0.25, gx * 0.35, 0);
    }
}

function loop() {
    rafId = requestAnimationFrame(loop);
    if (!ready || document.hidden || !stage.offsetWidth) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt;
    frame(dt);
    renderer.render(scene, camera);
}

/* ---------- public API ---------- */
window.Avatar = {
    init,
    isReady: () => ready,
    setState(s) { if (['LISTENING', 'PROCESSING', 'SPEAKING', 'LOADING'].includes(s)) state = s === 'LOADING' ? 'PROCESSING' : s; },
    unlockAudio,
    attachAudio,
    detachAudio,
    startTimedSpeech() { timedOn = true; },
    stopTimedSpeech() { timedOn = false; },
    config: CFG
};
