/**
* Copyright 2021 Mikhail Goncharov
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*      http://w.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

import { Howl } from "howler";
import Konva from "konva";
import { cursor, layer, stage } from "./main";
import { resumeAttrUpdates, setAttr, getAttr, initAttr, attrInput, attrNamespace, createAttrFunc, suspendAttrUpdates, watchAttr, BooleanAttribute } from './storage';
import { Point } from "./point";
import specs from './specs.json';
import theme from '../theme.json';
import { addStat, distanceScore, loadStats, percentile, statsForSetup, TrialSetup } from "./stats";
import { numberToDate, today } from "./utils";


let sound: Howl | null = null;
let soundPath = '';
const weapons = new Map<string, Weapon>();
const colorStartCircle = theme.colorStartCircle;
const colorHintPath = theme.colorHintPath;
const scoreGradient = theme.scoreGradient;
let shooting: Shooting | null = null;
let movingTarget: MovingTarget | null = null;
const traceShapeTypes = 3;
let traceShapes: Konva.Shape[][] = [];

let startRectangle = new Konva.Rect({
    stroke: theme.foreground,
    strokeWidth: 0.5,
    dash: [1, 9],
});
let pattern: Point[] = [];
let patternBox: [Point, Point];
let animation: Konva.Animation | null = null;
const NS = 'game:';
const aStationaryTarget = new BooleanAttribute('stationary-target', NS, true);
const aShowDetailedStats = new BooleanAttribute('show-detailed-stats', NS, false);
const aShowSensitivityWarn = new BooleanAttribute('show-sensitivity-warn', NS, false);
const aShowInstructions = new BooleanAttribute('show-instructions', NS, true);
const aMovingTarget = new BooleanAttribute('moving-target', NS, false)

export interface MagInfo {
    size: number;
    audio: string;
};

export interface Weapon {
    name: string;
    mags: MagInfo[];
    timePoints: number[];
    x: number[];
    y: number[];
}

interface Rect {
    topLeft: Point;
    bottomRight: Point;
}

class MovingTarget {
    pos = new Point();
    screenRect: Rect;
    circle: Konva.Circle;
    skew = 7;
    constructor() {
        this.screenRect = {
            topLeft: new Point(),
            bottomRight: new Point(),
        };
        this.circle = new Konva.Circle({
            radius: 6,
            stroke: 'blue',
            strokeWidth: 2,
            position: this.pos,
        });
        layer.add(this.circle);
    }
    frame() {
        if (this.pos.x < this.screenRect.topLeft.x
            || this.pos.x > this.screenRect.bottomRight.x
            || this.pos.y < this.screenRect.topLeft.y
            || this.pos.y > this.screenRect.bottomRight.y
            || true) {
                this.pos.x = Math.max(0, (this.screenRect.topLeft.x + this.screenRect.bottomRight.x) / 2);
                this.pos.y = Math.max(0, (this.screenRect.topLeft.y + this.screenRect.bottomRight.y) / 2);
            }
        this.circle.position(this.pos);
        return true;
    }
    clear() {
        this.circle.destroy();
    }
}

export function trialSetup(): TrialSetup {
    const weapon = getAttr('weapon');
    let mag = getAttr('mag');
    if (weapon == 'prowler') mag = '0';
    return {
        weapon,
        mag,
        hint: getAttr('hint'),
    };
}

function instructionsControls() {
    aShowInstructions.watch((v: boolean) => {
        const e = document.getElementById('instructions');
        if (!e) return;
        if (!v) {
            e.classList.add('hidden');
        } else {
            e.classList.remove('hidden');
            aShowDetailedStats.set(false);
        }
    });
    {
        const e = document.getElementById('dismiss-instructions');
        e?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            aShowInstructions.set(false);
            return false;
        });
    }

    {
        const e = document.getElementById('show-instructions-btn');
        e?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            aShowInstructions.set(true);
            return false;
        });
    }
}

function updateSound() {
    if (getAttr('mute') == 'true') return;
    const w = weapons.get(getAttr('weapon'));
    if (w == null) {
        console.log('weapon', getAttr('weapon'), 'not found');
        return;
    }
    const newPath = `./audio/${w.mags[Number(getAttr('mag'))].audio}.mp3`;
    if (soundPath != newPath) {
        soundPath = newPath;
        sound = new Howl({ src: soundPath });
    }
}

function soundControls() {
    watchAttr(['weapon', 'mag', 'mute'], updateSound);
    const mute = (document.getElementById('muted') as HTMLImageElement);
    const unmute = (document.getElementById('unmuted') as HTMLImageElement);
    if (mute != null || unmute != null) {
        watchAttr(['mute'], (v: string) => {
            if (v == 'true') {
                unmute.classList.add('hidden');
                mute.classList.remove('hidden');
            } else {
                unmute.classList.remove('hidden');
                mute.classList.add('hidden');
            }
        });
        unmute.addEventListener('click', () => setAttr('mute', 'true'));
        mute.addEventListener('click', () => setAttr('mute', 'false'));
    }
}

function scale() {
    const sens = Number(getAttr('sens'));
    return 1 / sens;
}


function gradientColor(x: number) {
    x = Math.min(1, Math.max(0, x));
    // Make gradient more pronounced around 1..0.9.
    x = 1 - Math.sqrt(1 - x * x);
    const idx = Math.round(x * 10);
    return scoreGradient[idx];
}

function box(pattern: Point[]): [Point, Point] {
    const a = new Point();
    const b = new Point();
    pattern.forEach(p => {
        const d = pattern[0].clone().sub(p);
        a.x = Math.min(a.x, d.x);
        a.y = Math.min(a.y, d.y);
        b.x = Math.max(b.x, d.x);
        b.y = Math.max(b.y, d.y);
    });
    return [a, b];
}

function drawPattern(pattern: Point[], mag: number, start: Point, sc: number) {
    const hintLinePoints: number[] = [];
    const circles: Konva.Circle[] = [];
    pattern.forEach((p, i) => {
        if (i >= mag) return;
        const xy = start.clone().sub(p);
        hintLinePoints.push(xy.x, xy.y);
        if (sc > 0.3) {
            const c = new Konva.Circle({
                radius: 1,
                stroke: colorHintPath,
                strokeWidth: 1,
                position: xy,
            });
            circles.push(c);
        }
    });
    const hintLine = new Konva.Line({
        points: hintLinePoints,
        stroke: colorHintPath,
        strokeWidth: 1,
    });
    return [hintLine, circles];
}

function showSelectedTrace() {
    clear();
    const name = getAttr('weapon');
    const w = weapons.get(name);
    const sc = scale();
    if (!Number.isFinite(sc) || sc < 0.1) return;
    if (w == null) {
        console.error('weapon', getAttr('weapon'), 'not found');
        return;
    }
    const n = w.mags[Number(getAttr('mag'))].size;
    pattern = [];
    for (let i = 0; i < n; i++) pattern.push(new Point(w.x[i], w.y[i]).s(sc));
    patternBox = box(pattern);
    const [line, circles] = drawPattern(pattern, n, patternBox[0].clone().s(-1).add(new Point(50, 50)), sc);
    layer.add(line as Konva.Line);
    (circles as Konva.Circle[]).forEach(c => layer.add(c));
    redrawStartRectangle();
    redraw();
}

let redrawTimeout: number | null;
function redraw() {
    if (redrawTimeout) return;
    redrawTimeout = window.setTimeout(() => {
        stage.batchDraw();
        redrawTimeout = null;
    }, 0);
}

function redrawStartRectangle() {
    if (patternBox.length < 2) return;
    const r = stage.container().getBoundingClientRect();
    const p = patternBox[0].clone();
    const bottomRight = new Point(
        window.innerWidth - r.left - patternBox[1].x - 50,
        window.innerHeight - r.top - patternBox[1].y - 50);
    const topLeft = p.clone().s(-1);
    const wh = bottomRight.sub(topLeft);
    aShowSensitivityWarn.set(wh.x < 100 || wh.y < 100);
    startRectangle.x(Math.max(1, topLeft.x));
    startRectangle.y(Math.max(1, topLeft.y));
    startRectangle.width(wh.x);
    startRectangle.height(wh.y);
    layer.add(startRectangle);
    if (movingTarget != null) {
        movingTarget.screenRect.topLeft = topLeft;
        movingTarget.screenRect.bottomRight = bottomRight;
    }
    redraw();
}

function clear() {
    layer.removeChildren();
    traceShapes = [];
}

function weaponControls() {
    specs.forEach(s => {
        weapons.set(s.name, {
            name: s.name,
            mags: s.mags.map(m => {
                var z: MagInfo = { size: m.size, audio: m.audio };
                return z;
            }),
            timePoints: s.time_points,
            x: s.x,
            y: s.y,
        });

        const d = document.querySelector(`#weapon-select .${s.name}`) as HTMLDivElement;
        if (d != null) {
            d.addEventListener('click', () => {
                setAttr('weapon', s.name);
            });
        }
    });

    watchAttr('weapon', (v: string) => {
        const s = document.querySelector(`#weapon-select .selected`) as HTMLDivElement;
        if (s != null) s.classList.remove('selected');
        const d = document.querySelector(`#weapon-select .${v}`) as HTMLDivElement;
        if (d == null) return;
        d.classList.add('selected');
    });

    for (let i = 0; i <= 3; i++) {
        const d = document.querySelector(`#mag-select .mag-${i}`) as HTMLDivElement;
        if (d != null) {
            d.addEventListener('click', () => { setAttr('mag', i + ''); });
        } else {
            console.error(`#mag-select .mag-${i}`, 'not found');
        }
    }

    watchAttr('mag', (v: string) => {
        const s = document.querySelector(`#mag-select .selected`) as HTMLDivElement;
        if (s != null) s.classList.remove('selected');
        const d = document.querySelector(`#mag-select .mag-${v}`) as HTMLDivElement;
        if (d == null) return;
        d.classList.add('selected');
    });
}

function statControls() {
    aShowDetailedStats.watch((v: boolean) => {
        const e = document.getElementById('detailed-stats');
        if (!e) return;
        if (v) {
            e.classList.remove('hidden');
            aShowInstructions.set(false);
            showStats();
        } else {
            e.classList.add('hidden');
        }
    });
    document.getElementById('hide-stats')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        aShowDetailedStats.set(false);
        return false;
    });
    document.getElementById('stats-graph-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        aShowDetailedStats.set(!aShowDetailedStats.get());
        return false;
    });
}

function showStats() {
    const s = statsForSetup(trialSetup());
    if (aShowDetailedStats.get()) {
        const x: string[] = [];
        const median: number[] = [];
        const best: number[] = [];
        const count: number[] = [];
        if (s) {
            s.dayResults.forEach(dayResults => {
                x.push(numberToDate(dayResults[0]));
                median.push(dayResults[2]);
                best.push(dayResults[3]);
                count.push(dayResults[1]);
            });
            if (s.todayResults.length > 0) {
                x.push(numberToDate(today()));
                median.push(percentile(s.todayResults, 0.5));
                best.push(percentile(s.todayResults, 1));
                count.push(s.todayResults.length);
            }
        }
        (window as any).updateGraph(x, median, best, count);
    }
    const b = document.getElementById('score-stats');
    if (b) {
        b.innerText = "Today's tries -, median -, best -\nAll time best -";
        if (s) {
            if (s.todayResults.length > 0) {
                b.innerText = `Today's tries ${s.todayResults.length}, median ${Math.round(percentile(s.todayResults, 0.5))}, best ${percentile(s.todayResults, 1)}
                    All time best ${s.bestAllTime}`;
            } else {
                b.innerText = `Today's tries -, median -, best -\nAll time best ${s.bestAllTime}`;
            }
        }
    }
}

class Shooting {
    center: Point; // Starting position.    
    totalFrames = 0;
    score = 0;
    mag = 1;
    speed = 1;
    hitMarker = new Konva.Circle();
    hitCursors: Point[] = [];
    pattern: Point[] = [];
    hitScores: number[] = [];
    showHint = true;
    start_t = 0;
    weapon: Weapon;
    hitIndex = -1; // Position in the patter we already passed.
    hitMarkers: Konva.Circle[] = [];
    crossHair?: Konva.Circle;
    hintGroup: Konva.Group;
    wallGroup: Konva.Group;
    recoilGroup: Konva.Group;
    fpsText: Konva.Text;
    recoilTarget: boolean;

    constructor() {
        this.center = new Point();
        this.weapon = weapons.get(getAttr('weapon'))!;
        if (this.weapon == null) throw Error("weapon not found");
        this.hintGroup = new Konva.Group();
        layer.add(this.hintGroup);
        this.wallGroup = new Konva.Group();
        layer.add(this.wallGroup);
        this.recoilGroup = new Konva.Group();
        layer.add(this.recoilGroup);
        this.fpsText = new Konva.Text({
            text: `FPS: -`,
            fontSize: 14,
            fill: theme.foreground,
            shadowBlur: 0,
            shadowOffset: { x: 1, y: 1 },
            shadowOpacity: 1,
            x: 10,
            y: 10,
        });
        layer.add(this.fpsText);
        this.recoilTarget = !aStationaryTarget.get();
        redrawStartRectangle();
    }

    start() {
        this.start_t = Date.now();
        this.center = cursor();
        suspendAttrUpdates();
        this.weapon = weapons.get(getAttr('weapon'))!;
        if (this.weapon == null) throw Error("weapon not found");
        const sc = scale();
        this.speed = Math.min(1, Math.max(0.1, Number(getAttr('speed')) / 100));
        this.mag = this.weapon.mags[Number(getAttr('mag'))]?.size || 1;
        if (getAttr('mute') != 'true' && sound != null) {
            sound.volume(Number(getAttr('volume')) / 100);
            sound.rate(this.speed);
            sound.play();
        }
        for (let i = 0; i < traceShapeTypes; i++) traceShapes.push([]);
        this.showHint = getAttr('hint') == 'true';
        this.hintGroup.visible(this.showHint);
        // Target.
        const target = new Konva.Circle({
            radius: 2 + 4 * sc,
            stroke: colorStartCircle,
            strokeWidth: 1 + 1 * sc,
            position: this.center.plain(),
        });
        if (this.recoilTarget) {
            this.wallGroup.add(target);
        } else {
            if (this.showHint) {
                this.recoilGroup.add(target);
            } else {
                layer.add(target);
            }
        }
        this.pattern = this.weapon.x.map((x, idx) => {
            return new Point(x, this.weapon.y[idx]).s(sc);
        });
        {
            const [ln, circles] = drawPattern(this.pattern, this.mag, this.center, sc);
            this.hintGroup.add(ln as Konva.Line);
            (circles as Konva.Circle[]).forEach(c => this.hintGroup.add(c));
        }
        // Replace cursor with a fixed point.
        if (this.recoilTarget) {
            this.crossHair = new Konva.Circle({
                radius: 2,
                fill: 'red',
                position: this.center.plain(),
            });
            layer.add(this.crossHair);
        }
        if (this.recoilTarget || !this.showHint) {
            stage.container().classList.add('no-cursor');
        }
        this.frame();
        stage.batchDraw();
        stage.listening(false);
    }

    recoilVector(t: number, i: number): [Point, number] {
        while (i + 1 < this.mag && t > this.weapon.timePoints[i + 1]) i++;
        if (i == -1) return [new Point(), i];
        if (i + 1 >= this.mag) return [this.pattern[this.mag - 1].clone(), i];
        const dt = (this.weapon.timePoints[i + 1] - this.weapon.timePoints[i]);
        let progress = Math.max(Math.min((t - this.weapon.timePoints[i]) / dt, 1), 0);
        const p = this.pattern[i];
        return [this.pattern[i + 1].clone().sub(p).s(progress).add(p), i];
    }

    frame() {
        this.fpsText.text(`FPS: ${Math.round(1000 * this.totalFrames / (Date.now() - this.start_t))}`);[[[[[[[[[]]]]]]]]]
        this.totalFrames++;
        const sc = scale();
        const cur = cursor();
        const dCur = cur.clone().sub(this.center);
        if (this.recoilTarget) this.hintGroup.offset(dCur);
        const frame_t = (Date.now() - this.start_t) * this.speed + 8; // Add half frame.
        let [rv, i] = this.recoilVector(frame_t, this.hitIndex);
        let [rvFwd, _] = this.recoilVector(frame_t + 24, i);
        this.recoilGroup.offset(rvFwd);
        this.wallGroup.offset(rv.clone().add(dCur));
        // Register new shots.
        while (this.hitIndex < i) {
            this.hitIndex++;
            const p = this.pattern[this.hitIndex];
            this.hitCursors.push(cur);
            let hit = cur.clone().add(p);
            const rawDistance = new Point(hit).distance(this.center) / sc;
            let s = distanceScore(rawDistance);
            this.hitScores.push(s);
            this.score += s;
            this.hitMarker.radius(this.recoilTarget ? 1 : 2);
            var hitP: Point;
            if (this.recoilTarget) {
                hitP = this.center.clone().add(new Point(this.wallGroup.offset()));
            } else {
                hitP = cur.clone().add(p);
            }
            this.hitMarker = new Konva.Circle({
                radius: Math.max(4 * sc, 2),
                fill: gradientColor(this.hitScores[this.hitScores.length - 1]),
                position: hitP,
            });
            this.hitMarkers.push(this.hitMarker);
            if (this.recoilTarget) {
                this.wallGroup.add(this.hitMarker);
            } else {
                layer.add(this.hitMarker);
            }
            traceShapes[0].push(this.hitMarker);
            this.hitMarker.zIndex(0); // To put behind the scope.
        }
        if (this.hitIndex + 1 >= this.mag) this.finish();
        return true;
    }

    finish() {
        shooting = null;
        stage.listening(true);
        resumeAttrUpdates();
        this.score /= this.mag;
        this.score = Math.max(0, Math.min(1, this.score));
        const x = Math.round(100 * this.score);
        if (this.speed == 1) addStat(x, trialSetup());
        this.hintGroup.visible(true);
        this.hitMarkers.forEach(m => m.radius(2));
        const txt = new Konva.Text({
            text: `${x}`,
            fontSize: 20,
            fill: gradientColor(this.score),
            shadowColor: theme.background,
            shadowBlur: 0,
            shadowOffset: { x: 1, y: 1 },
            shadowOpacity: 1,
        });
        txt.position(this.center.clone().add(new Point(20, -10)).plain());
        layer.add(txt);
        {
            // Display trail.
            this.hitCursors.forEach((cur, idx) => {
                const p = this.pattern[idx];
                let traceTarget = this.center.clone().sub(p);
                const clr = gradientColor(this.hitScores[idx]);
                const b = new Konva.Circle({
                    radius: 2,
                    fill: clr,
                    position: cur.plain(),
                    visible: false,
                });
                this.hintGroup.add(b);
                traceShapes[1].push(b);
                const c = new Konva.Line({
                    points: [cur.x, cur.y, traceTarget.x, traceTarget.y],
                    stroke: clr,
                    strokeWidth: 1,
                    visible: false,
                });
                traceShapes[2].push(c);
                this.hintGroup.add(c);
            });
            displayTace();
        }
        this.hintGroup.offset(new Point(0, 0));
        this.wallGroup.offset(new Point(0, 0));
        this.recoilGroup.offset(new Point(0, 0));
        this.crossHair?.visible(false);
        stage.container().classList.remove('no-cursor');
        if (getAttr('toggle-modes') == 'true') setAttr('hint', `${!this.showHint}`);
        redrawStartRectangle();
        redraw();
    }
}

function displayTace() {
    const d = Number(getAttr('trace-mode')) % traceShapeTypes;
    traceShapes.forEach((sh, i) => sh.forEach(s => s.visible(i == d)));
}

export function setupGame() {
    /* https://konvajs.org/docs/sandbox/Animation_Stress_Test.html#page-title
    * setting the listening property to false will improve
    * drawing performance because the rectangles won't have to be
    * drawn onto the hit graph */
    layer.listening(false);
    attrNamespace('game:');
    initAttr('sens', '5');
    initAttr('weapon', 'r99'); 1
    initAttr('mag', '0');
    initAttr('stats', '[]');
    initAttr('volume', '20');
    initAttr('mute', 'false');
    initAttr('hint', 'true');
    initAttr('trace-mode', '1');
    initAttr('toggle-modes', 'false');
    initAttr('speed', '100');

    loadStats();

    attrInput('sens', NS);
    attrInput('hint', NS);
    attrInput('volume', NS);
    attrInput('speed', NS);
    attrInput('toggle-modes', NS);

    soundControls();
    instructionsControls();
    weaponControls();
    statControls();
    watchAttr(['weapon', 'mag', 'sens'], showSelectedTrace);
    window.addEventListener('resize', redrawStartRectangle);
    aShowDetailedStats.watch(redrawStartRectangle);
    aShowInstructions.watch(redrawStartRectangle);
    watchAttr(['stats', 'mag', 'weapon', 'hint'], showStats);
    watchAttr(['speed'], (v: string) => {
        const b = document.getElementById('speed-value');
        if (!b) return;
        const s = Number(v);
        b.innerText = s == 100 ? 'normal' : `x ${s / 100}`;
    });
    watchAttr('trace-mode', () => {
        displayTace();
        stage.batchDraw();
    });
    aShowSensitivityWarn.watch((v: boolean) => {
        const w = document.getElementById('sensitivity-warning');
        if (w == null) return;
        if (v) {
            w.classList.remove('hidden');
        } else {
            w.classList.add('hidden');
        }
    });
    stage.on('mousedown', function (e: Konva.KonvaEventObject<MouseEvent>) {
        e.evt.preventDefault();
        switch (e.evt.button) {
            case 0:
                if (shooting == null) {
                    clear();
                    shooting = new Shooting();
                    shooting.start();
                }
                break;
            case 1:
                setAttr('trace-mode', `${(Number(getAttr('trace-mode')) + 1) % traceShapeTypes}`);
                break;
            default:
                break;
        }
    });
    aMovingTarget.watch((v: boolean) => {
        console.log('moving target updated', v, movingTarget != null);
        if ((movingTarget == null) != v) return;
        if (v) {
            movingTarget = new MovingTarget();
            redrawStartRectangle();
        } else {
            movingTarget?.clear();
            movingTarget = null;
            redraw();
        }
    })
    animation = new Konva.Animation(() => {
        let updated = false;
        if (shooting != null) {
            shooting.frame();
            updated = true;
        }
        if (movingTarget != null) {
            movingTarget.frame();
            updated = true;
        }
        return updated;
    }, [layer]);
    animation.start();
}